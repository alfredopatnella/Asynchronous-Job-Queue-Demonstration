# Seguridad

🌐 Idioma: [English](../security.md) | **Español**

Este es un ejemplo educativo, no un sistema de producción reforzado. Este
documento es explícito sobre qué está y qué no está cubierto, para que no
se confunda con una postura de seguridad completa.

## Límites de confianza (trust boundaries)

```text
Internet (no confiable)
   │  HTTPS (TLS, aplicado por API Gateway)
   ▼
API Gateway  ──────────────────────────  Límite de la cuenta de AWS
   │  Invocación de Lambda autorizada por IAM
   ▼
Producer Lambda
   │  sqs:SendMessage autorizado por IAM
   ▼
Cola de trabajos SQS  ──  Cola de mensajes fallidos SQS (DLQ)
   │  poll/receive/delete autorizado por IAM (vía event source mapping)
   ▼
Worker Lambda
```

Todo lo que está a la izquierda de API Gateway es entrada no confiable.
Todo lo que está a la derecha se ejecuta bajo roles de IAM delimitados por
este stack.

## IAM / mínimo privilegio

- El rol de ejecución de la función **producer** solo tiene concedido
  `sqs:SendMessage` (más el pequeño conjunto de llamadas de solo lectura
  sobre atributos de la cola que el SDK necesita para construir la
  solicitud) sobre el **ARN de la cola principal**. No tiene permisos sobre
  la DLQ ni permisos para recibir o eliminar mensajes.
- El rol de ejecución de la función **worker** solo tiene concedidos los
  permisos de recibir/eliminar/cambiar-visibilidad que requieren los event
  source mappings de SQS, delimitados a la cola principal. No tiene el
  permiso `sqs:SendMessage` en ningún lugar — no puede publicar nuevos
  trabajos ni escribir en la DLQ por sí mismo (el redrive a la DLQ lo
  realiza el servicio de SQS, no credenciales que posea el worker).
- Ambos roles son creados por los constructos L2 de CDK
  (`grantSendMessages`, `SqsEventSource`), que generan políticas con
  alcance a recursos específicos en lugar de declaraciones comodín
  (`Resource: "*"`).

## Exposición de la API

- `POST /jobs` es un endpoint público y **no autenticado** en este
  ejemplo.
- El tráfico se sirve sobre HTTPS mediante API Gateway; no hay ninguna ruta
  en HTTP plano.
- No hay rate limiting, WAF, ni plan de uso (*usage plan*) configurado. Un
  despliegue real detrás de este patrón debería agregar al menos uno de:
  un plan de uso de API Gateway con throttling, AWS WAF, o autenticación
  que permita atribuir y limitar el tráfico por llamador.

## Validación de entrada

El producer realiza una validación mínima: requiere que `reportType` y
`requestedBy` estén presentes, sean strings no vacíos, y rechaza cuerpos
que no sean JSON válido. No hace lo siguiente:

- No aplica una lista blanca de valores válidos para `reportType`.
- No limita la longitud de los strings.
- No sanitiza `requestedBy` más allá de la verificación de tipo.

Cualquiera de estas sería una adición razonable antes de aceptar tráfico de
producción no confiable; son deliberadamente mínimas aquí para que la
lógica de validación no distraiga de la lección sobre colas.

## Consideraciones de denegación de servicio (DoS)

- **Lado del producer**: API Gateway tiene throttling por defecto a nivel
  de cuenta, pero nada en este stack limita cuántos trabajos puede encolar
  un solo llamador. Un llamador malicioso o defectuoso podría inundar la
  cola.
- **Lado del worker**: `reservedConcurrentExecutions: 2` es en realidad un
  activo de seguridad aquí, no solo un recurso didáctico — limita cuánto
  cómputo concurrente (y cualquier llamada downstream que un worker real
  pudiera hacer) puede provocar una inundación de la cola. La cola absorbe
  el exceso en lugar de que el worker escale su concurrencia sin límite.
- SQS en sí mismo escala para absorber backlogs muy grandes, así que una
  inundación se manifiesta como un crecimiento de
  `ApproximateAgeOfOldestMessage` en lugar de una caída del sistema — de
  eso se encarga la alarma `job-queue-oldest-message-age`.

## Cifrado

- **En tránsito**: API Gateway solo sirve HTTPS/TLS; las llamadas del SDK
  de AWS desde ambas Lambdas hacia SQS usan TLS por defecto.
- **En reposo**: las colas de este ejemplo usan el cifrado por defecto de
  SQS (SSE-SQS, llaves administradas por AWS). Para cargas de trabajo con
  requisitos de cumplimiento más estrictos, cambia a SSE-KMS con una llave
  administrada por el cliente (`encryption: QueueEncryption.KMS` en CDK)
  para que el uso de la llave sea auditable y el acceso pueda restringirse
  independientemente de los permisos de la cola.

## Logging y datos sensibles

- Ambas Lambdas registran JSON estructurado, incluyendo `jobId` y
  `reportType`, en CloudWatch Logs. **No incluyas PII, credenciales u otros
  valores sensibles en el payload del trabajo** (`reportType`,
  `requestedBy`, etc.) en un despliegue real — cualquier cosa que pase por
  la cola puede terminar en CloudWatch Logs, y si un trabajo falla
  repetidamente, en la DLQ, ambos más accesibles ampliamente que una base
  de datos de aplicación normal.
- El acceso a CloudWatch Logs se controla mediante IAM como cualquier otro
  recurso de AWS; este ejemplo no agrega restricciones adicionales más allá
  de los permisos por defecto de la cuenta. Restringe
  `logs:GetLogEvents`/`logs:FilterLogEvents` en estos grupos de logs a las
  personas que realmente los necesiten, especialmente una vez que datos
  reales fluyan por el sistema.

## Consideraciones sobre la cola de mensajes fallidos (DLQ)

La DLQ retiene copias completas de los mensajes fallidos (14 días aquí)
únicamente para inspección del operador. Debido a que contiene el mismo
payload que la cola principal, hereda la misma preocupación de "no pongas
datos sensibles en el payload" — y podría decirse que una más fuerte, ya
que el contenido de la DLQ suele ser revisado manualmente por quien esté
depurando el fallo, lo cual es una audiencia más amplia que el worker
automatizado.

## Autenticación

No hay **autenticación** deliberadamente en `POST /jobs`. Agregar Cognito,
autenticación IAM, o un autorizador personalizado quedó explícitamente
fuera del alcance de este ejemplo (ver el README) para que el patrón de
colas se mantenga como el foco. Un despliegue de producción debe agregar
uno de los siguientes:

- Un autorizador de API Gateway (Cognito, IAM, o un autorizador Lambda).
- Un gateway/servicio delante de API Gateway que autentique a los
  llamadores.

## Controles de seguridad implementados en este ejemplo

- Endpoint de API Gateway solo TLS.
- IAM de mínimo privilegio: el producer solo puede enviar, el worker solo
  puede recibir/eliminar, ninguno tiene permisos amplios sobre SQS.
- Sin políticas de IAM con recursos comodín.
- Concurrencia reservada que limita el radio de impacto / agotamiento de
  recursos.
- Logging estructurado sin secretos incrustados en el payload de ejemplo.

## Controles de seguridad recomendados para producción

- Autenticación/autorización de la API (Cognito, autenticación IAM, o
  autorizador personalizado).
- Throttling de solicitudes / planes de uso / WAF.
- Cifrado SSE-KMS con una llave administrada por el cliente en ambas
  colas.
- Validación de entrada más estricta (listas blancas, límites de
  longitud).
- Redacción de campos de log o una política contra incluir datos
  sensibles en los payloads de los trabajos, reforzada por revisión o
  escaneo automatizado.
- Acceso de lectura a CloudWatch Logs más restringido vía IAM.
- Un proceso definido de redrive para la DLQ con pista de auditoría.
- Aislamiento de red basado en VPC si el worker llama a sistemas
  downstream internos/privados.
