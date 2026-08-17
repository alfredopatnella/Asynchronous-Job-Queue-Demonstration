# Solución de problemas

🌐 Idioma: [English](../troubleshooting.md) | **Español**

Una guía práctica para diagnosticar los problemas más comunes al ejecutar
o demostrar este stack.

## La API devuelve 5xx

**Revisa, en orden:**

1. **Logs del Producer Lambda** (CloudWatch Logs, grupo de logs
   `/aws/lambda/job-queue-producer`). Busca un stack trace — la mayoría de
   los 5xx son una excepción no manejada en el producer, a menudo desde la
   llamada al SDK de SQS.
2. **Permisos de `sqs:SendMessage`**. Si el rol de IAM del producer o la
   variable de entorno `QUEUE_URL` están mal configurados (por ejemplo,
   apuntando a una cola en otro stack/cuenta), `SendMessageCommand`
   lanzará una excepción. Confirma que `QUEUE_URL` coincide con el output
   del stack `JobQueueUrl`.
3. **Payload de solicitud malformado**. Un 400 (no 5xx) es esperado para
   un cuerpo incorrecto — esto es la validación propia del producer
   funcionando correctamente, no un bug. Si ves 5xx en lugar de 400 para
   un cuerpo incorrecto, el handler mismo está lanzando una excepción
   antes de que la validación se ejecute; revisa si hay un problema de
   parseo de JSON antes del `try`/`catch` en `src/producer/handler.ts`.

## Los mensajes permanecen en la cola (no se procesan)

**Revisa, en orden:**

1. **Estado del event source mapping**. En la consola de Lambda, abre la
   pestaña "Triggers" de la función worker y confirma que el trigger de
   SQS muestre `Enabled`, no `Disabled`.
2. **Errores del worker**. Si la función worker misma está fallando (no
   solo trabajos individuales), todo el lote falla y nada se elimina.
   Revisa los logs de `/aws/lambda/job-queue-worker` en busca de
   excepciones fuera del `try`/`catch` por registro en `handler.ts` (por
   ejemplo, un despliegue defectuoso, una dependencia faltante tras el
   empaquetado).
3. **Concurrencia reservada**. `reservedConcurrentExecutions: 2` significa
   que solo 2 invocaciones se ejecutan a la vez. Si la cola tiene un
   backlog grande, esto es esperado — los mensajes esperan su turno. Esto
   es contrapresión funcionando como fue diseñado, no un bug.
4. **Throttling**. Si ves `Rate Exceeded` o errores de throttling en el
   worker, algo (a menudo la concurrencia reservada siendo consumida por
   completo por otra carga de trabajo que comparte la cuenta, o un límite
   de concurrencia a nivel de cuenta) está impidiendo las invocaciones.
   Revisa la métrica `Throttles` de la función Lambda en CloudWatch.

## Un mensaje sigue reintentándose

**Revisa, en orden:**

1. **Logs del worker para el `jobId` de ese trabajo**. Confirma si
   `processJob()` realmente está lanzando una excepción, y por qué.
2. **`ApproximateReceiveCount`**. Cada reintento incrementa este valor. El
   worker lo registra en cada intento de procesamiento — busca en los logs
   el `jobId` para ver el conteo subiendo (1, 2, 3...).
3. **`simulateFailure` deliberado**. Si enviaste el trabajo con
   `"simulateFailure": true`, esto es esperado: está diseñado para fallar
   siempre, a propósito, para que puedas observar la ruta de reintento →
   DLQ de principio a fin.
4. **Tiempo de visibilidad**. Si los trabajos se reintentan
   *inesperadamente rápido* o se *solapan* consigo mismos, confirma que el
   tiempo de visibilidad de la cola (90s) siga siendo cómodamente mayor
   que el tiempo real de procesamiento del worker (debería estar muy por
   debajo del timeout de 15s de la función). Si alguien reduce el tiempo
   de visibilidad sin reducir el timeout de la función para que coincida,
   un trabajo lento pero exitoso puede ser reentregado a un segundo worker
   mientras el primero todavía se está ejecutando.
5. **Política de redrive**. Confirma que `maxReceiveCount` en la política
   de redrive de la cola principal siga siendo 3, y que apunte al ARN
   correcto de la DLQ (`cdk diff` te mostrará la plantilla actual si no
   estás seguro de qué está desplegado).

## Aparecen mensajes en la DLQ

Esto significa que el mensaje fue recibido y falló **3 veces** (el
`maxReceiveCount` configurado) — los reintentos se agotaron, no es un
incidente aislado. Para investigar:

1. Lee el cuerpo del mensaje en la DLQ (vía la consola de SQS o el CLI)
   para obtener el `jobId` y los detalles del trabajo.
2. Busca en CloudWatch Logs ese `jobId` a través de los 3 intentos para
   entender por qué siguió fallando (¿`simulateFailure: true`? ¿un bug
   real? ¿un problema de una dependencia downstream en un worker
   modificado?).
3. La DLQ **no** repara ni reintenta nada por sí misma. Una vez que
   entiendas y corrijas la causa raíz, reenviarías (*redrive*) el mensaje
   manualmente (por ejemplo, usando la función integrada de SQS "start
   message move task") de vuelta a la cola principal, o lo descartarías si
   ya no es relevante.

## Todo el lote parece reintentarse (no solo el mensaje que falló)

Esto significa que las respuestas de fallo parcial del lote no están
surtiendo efecto. Revisa:

1. Que el event source mapping tenga `reportBatchItemFailures: true`
   (`FunctionResponseTypes: ["ReportBatchItemFailures"]` en el
   CloudFormation sintetizado — verifícalo con `cdk synth` o la consola).
2. Que el handler del worker esté devolviendo `{ batchItemFailures: [...] }`
   y no lanzando una excepción no manejada para todo el lote. Una
   excepción lanzada en el nivel superior de `handler()` (a diferencia de
   dentro del `try`/`catch` por registro) hará fallar toda la invocación
   sin importar la configuración de `reportBatchItemFailures`.
3. Que cada entrada de fallo use el nombre y valor de campo correcto:
   `itemIdentifier` debe coincidir exactamente con el `messageId` del
   registro.

## El worker parece ejecutarse varias veces para el mismo trabajo

Esto es esperado bajo el modelo de **entrega al menos una vez** de SQS —
no es necesariamente un bug. Causas comunes:

- El worker tuvo éxito, pero el acuse de eliminación se perdió o se
  retrasó más allá del tiempo de visibilidad, así que SQS reentregó el
  mensaje (ya procesado).
- `simulateFailure: true` causa una reentrega deliberadamente.
- El tiempo de visibilidad era demasiado corto en relación con el tiempo
  real de procesamiento.

La solución es arquitectónica, no un parche puntual: los workers de
producción deben ser idempotentes (ver la sección "Por qué importa la
idempotencia" del README y los comentarios en `src/worker/handler.ts`).

## El despliegue de CloudFormation falla (`cdk deploy`)

**Revisa, en orden:**

1. **Credenciales**. Ejecuta `aws sts get-caller-identity` para confirmar
   que estás autenticado como la cuenta/rol que esperas.
2. **Región**. Confirma que `AWS_REGION`/`AWS_DEFAULT_REGION` (o la región
   configurada en tu perfil de CLI) sea la región en la que pretendes
   desplegar.
3. **Bootstrap de CDK**. Si ves un error que menciona un stack de bootstrap
   faltante o un parámetro de SSM (`/cdk-bootstrap/...`), ejecuta
   `npx cdk bootstrap aws://ACCOUNT-ID/REGION` una vez para esa
   cuenta/región, y luego reintenta `cdk deploy`.
4. **Permisos de despliegue de IAM**. `cdk deploy` necesita permisos para
   crear roles de IAM, funciones Lambda, colas SQS, recursos de API
   Gateway, y alarmas/grupos de logs de CloudWatch (típicamente vía
   CloudFormation). Los permisos insuficientes usualmente se manifiestan
   como un evento de stack `ROLLBACK_COMPLETE` con una razón `AccessDenied`
   en la consola de CloudFormation — revísala ahí para ver la acción
   denegada exacta.
