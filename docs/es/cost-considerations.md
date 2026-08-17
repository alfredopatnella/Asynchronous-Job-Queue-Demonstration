# Consideraciones de costos

🌐 Idioma: [English](../cost-considerations.md) | **Español**

> Los precios de AWS cambian con el tiempo y varían por región. Las cifras
> a continuación sirven para construir intuición sobre **qué genera
> costos** en esta arquitectura, no son una cotización. Siempre revisa las
> [páginas de precios de AWS](https://aws.amazon.com/pricing/) actuales
> para cifras precisas y actualizadas antes de estimar una carga de
> trabajo real.

## De dónde viene el costo

| Servicio | Qué genera costo aquí |
|---|---|
| API Gateway | Número de solicitudes a la API (llamadas a `POST /jobs`), más una pequeña cantidad de transferencia de datos. |
| Producer Lambda | Número de invocaciones (una por solicitud a la API) × duración facturada × memoria configurada. |
| SQS | Número de llamadas a la API que hace el *sistema* contra la cola — `SendMessage` (producer), más `ReceiveMessage`/`DeleteMessage`/`ChangeMessageVisibility` (el event source mapping sondeando en nombre del worker). |
| Worker Lambda | Número de invocaciones × duración facturada × memoria configurada. El procesamiento por lotes reduce directamente el número de invocaciones. |
| CloudWatch Logs | Volumen de datos de log ingeridos (bytes escritos por `console.log`) y por cuánto tiempo se retienen. |
| Alarmas de CloudWatch | Un pequeño costo mensual fijo por alarma (3 alarmas en este stack) más las evaluaciones de métricas, que a esta escala son efectivamente gratuitas. |

## Cómo afecta el batching al número de invocaciones

Sin procesamiento por lotes, N trabajos implicarían hasta N invocaciones
separadas del worker. Con `batchSize: 5`, el event source mapping puede
entregar hasta 5 mensajes por invocación cuando la cola tiene suficiente
backlog, lo que significa tan solo N/5 invocaciones del worker para los
mismos N trabajos. Dado que Lambda se factura por invocación y por unidad
de duración, el procesamiento por lotes puede reducir significativamente
el costo a escala — la contrapartida (discutida en
`docs/es/architecture.md`) es un radio de impacto de fallo mayor por
invocación, mitigado aquí mediante respuestas de fallo parcial del lote.

## Cómo afecta el logging al costo

Cada llamada a `console.log` en el producer y el worker se convierte en
bytes almacenados en CloudWatch Logs, facturados tanto por ingestión como
por almacenamiento durante el período de retención. Este ejemplo registra
una o dos líneas estructuradas por trabajo, lo cual es intencionalmente
modesto. Un worker que registre salida de depuración detallada en cada
invocación, a alto volumen, en un sistema de producción con mucho tráfico,
puede convertir a CloudWatch Logs en uno de los rubros más grandes de la
factura — vale la pena vigilarlo si extiendes el logging de este ejemplo.

## La cola suaviza la carga, no la hace gratis

SQS permite que una ráfaga de 10,000 trabajos entrantes sea procesada por 2
workers concurrentes a lo largo del tiempo, en lugar de requerir 10,000
ejecuciones simultáneas de Lambda. Eso es valioso para la confiabilidad y
para evitar sobrecargar sistemas downstream — pero el cómputo *total* de
Lambda (duración × invocaciones) necesario para procesar los 10,000
trabajos no se reduce porque agregaste una cola; es aproximadamente el
mismo trabajo total, solo distribuido en el tiempo. La cola cambia la forma
de la curva de costo (suavizada en lugar de en picos) y protege contra
sobrecargar sistemas downstream, pero no es, por sí sola, una técnica de
reducción de costos.

## Escenario conceptual de ejemplo

Supongamos que una demostración o una carga de trabajo pequeña procesa
**10,000 trabajos/mes**:

- **API Gateway**: 10,000 solicitudes (más lo que agregue el
  comportamiento de reintento de un cliente real).
- **Producer Lambda**: 10,000 invocaciones, cada una corta (validar + una
  llamada a SQS) — probablemente muy por debajo de un segundo de duración
  facturada cada una.
- **SQS**: 10,000 llamadas `SendMessage`, más las llamadas de sondeo
  `ReceiveMessage` que haga el event source mapping (esto escala con la
  frecuencia de sondeo y la actividad de la cola, no 1:1 con el número de
  trabajos) y 10,000 llamadas `DeleteMessage` para la ruta exitosa.
- **Worker Lambda**: tan solo 2,000 invocaciones (con un lote completo de
  5 por invocación) hasta 10,000 (si los trabajos llegan demasiado
  espaciados para agruparse), cada una ejecutándose durante
  aproximadamente lo que tarde `processJob()`.
- **CloudWatch Logs**: un puñado de líneas de log JSON cortas por trabajo,
  multiplicado por 10,000.

A este volumen, todo lo anterior típicamente cae dentro de (o muy cerca
de) el nivel gratuito perpetuo de AWS para Lambda, API Gateway y SQS en
muchas cuentas — pero la elegibilidad y los límites del nivel gratuito
también cambian, así que no lo trates como una garantía. Para convertir
esto en una estimación real, ingresa tu propio volumen esperado de
trabajos, duración de procesamiento promedio, y verbosidad de logging en
la [Calculadora de Precios de AWS](https://calculator.aws) usando las
tarifas actuales para API Gateway, Lambda, SQS y CloudWatch en tu región
de destino.
