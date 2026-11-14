<!-- coderabbit-ai-generated:v1 -->

# Harness-ecc 2.2.4 — estabilidad e integridad

Estado: candidato preparado; publicación pendiente de los controles de release. Este fork deriva de ECC de Affaan Mustafa y conserva su licencia MIT y atribuciones. No se ha publicado una nueva versión del paquete npm `ecc-universal`.

## Cambios

- Reconciliación de `main` con `codex/claude-skill-flatten`: se conserva la migración a skills planos, las protecciones de propiedad y la recuperación de instalaciones parciales presentes en `main`.
- SQLite/sql.js: bloqueo entre procesos durante lectura/modificación/exportación, recarga del snapshot y cierre sin sobrescribir el archivo con una copia obsoleta.
- Panel de control: escucha en loopback, comprobación del Origin completo, cuerpo limitado a 64 KiB, salida limitada y escalado de terminación de procesos.
- Python: historial de herramientas adaptado a cada protocolo, `LLM_MODEL` efectivo y operaciones síncronas fuera del bucle asíncrono.
- Sesiones: lectura limitada a los últimos 4 MiB, filtrado heurístico de credenciales antes del recorte, escritura atómica y permisos privados en POSIX. Se conservan las notas manuales; los contadores indican cuándo sólo representan la ventana reciente.
- Rust experimental: protección de estados de ejecución frente a resultados tardíos, límites de salida y aplicación de presupuestos/conflictos desde el daemon. La poda automática queda desactivada por defecto; el borrado manual conserva verificaciones de limpieza e integración.
- CI: cobertura Python mínima del 80 %, pruebas Rust en Linux y compilación de targets en Windows; ejecución en la rama de integración real del fork.

## Compatibilidad y operación

- El panel rechaza direcciones de escucha externas a loopback. Los clientes HTTP que envían Origin deben coincidir con el servidor; los clientes sin Origin conservan su comportamiento.
- Los accesos concurrentes a sql.js pueden devolver `ECC_STATE_STORE_LOCKED`: reintentar tras finalizar el escritor. Un bloqueo abandonado exige comprobar que no existe ningún escritor activo antes de retirar exclusivamente el directorio `.lock` correspondiente. No eliminar automáticamente bloqueos de procesos vivos. Escritores SQLite externos no participan de este protocolo.
- La recarga/exportación de snapshots añade coste de E/S según el tamaño de la base. No se presenta como almacenamiento distribuido ni como WAL nativo.
- La poda automática no puede garantizar ausencia de escrituras concurrentes sobre archivos ignorados; permanece desactivada por defecto. No se elimina ningún componente.
- El detector de secretos es heurístico; las notas manuales no se alteran. Los permisos POSIX no equivalen a una validación de ACL de Windows.
- Cancelar una coroutine no detiene una operación síncrona ya iniciada en un thread. Herramientas dependientes de un thread concreto necesitan adaptadores asíncronos.

## Verificación

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:e74dc2f9baf63b2b4c443b78137b77ae7530568f3334d0a627cd26a69ac5a54e -->

- Python: 187 pruebas y 64 subcasos; cobertura de ramas/líneas combinada del 82,70 %, Ruff y mypy correctos (Python 3.14.4; OpenAI 2.34.0). Python 3.11 queda pendiente del job de CI.
- Rust: 497 pruebas aprobadas, una prueba auxiliar ignorada e invocada por el test multiproceso; formato correcto. Clippy termina correctamente con 67 advertencias en el target de pruebas, 39 duplicadas, principalmente preexistentes.
<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:f3e467578fc65da2783b3a2d666ca2b7a73661ae9a18e0f91a3e86282d13c571 -->

- Node: almacenamiento 23/23 y panel 21/21; migración 17, ciclo de instalación 73, targets 51, enlaces 13, executor 24 e install-apply 47 aprobadas. Manifiestos 68/68 y empaquetado OpenCode 7/7. Cobertura global de código JavaScript: 90,03 % líneas/statements, 83,51 % ramas y 94,96 % funciones. La primera ejecución de 326 archivos encontró nueve fallos de documentación/fixture; quedaron resueltos y se reejecutaron las tres suites afectadas (41, 13 y 95 casos aprobados; un caso de filesystem insensible a mayúsculas omitido en Linux). Las demás suites aprobadas se reutilizaron. La medición global usó fast-uri 3.1.7; la actualización a 3.1.9 se verificó aparte con consumidores de esquemas, instalación y auditoría.

<!-- /coderabbit-ai-generated:v1 -->
- Dependencias: `fast-uri` actualizado a 3.1.9; 189 pruebas de validadores y consumidores de esquemas aprobadas con la dependencia nueva. npm y Yarn 4.9.2 instalan correctamente; 212 firmas verificadas y 26 attestations. Auditoría de producción: cero vulnerabilidades. Persisten 17 avisos al incluir dependencias de desarrollo (3 bajos, 8 moderados y 6 altos).
- Los casos adicionales encontrados en revisión interna (descendientes tras timeout, escrituras RETURNING, continuaciones de transacciones rechazadas, poda concurrente y fronteras UTF-8) se corrigieron y tienen regresiones.

Las pruebas usan datos sintéticos y proveedores simulados. La validación física, las APIs reales y la ejecución del supervisor en Windows siguen pendientes. Los componentes Python y Rust mantienen su condición experimental; esta release no certifica hardware ni memoria ECC. La identidad de procesos persistidos aún no incluye tiempo de inicio, por lo que queda pendiente endurecer la reutilización de PID tras reinicios.

<!-- /coderabbit-ai-generated:v1 -->

## Controles pendientes para publicar

1. Integrar el commit revisado en `main` sin perder el trabajo de la rama por defecto.
2. Obtener CI y CodeQL satisfactorios para ese commit exacto, con las categorías exigidas por `scripts/ci/verify-release-gates.js`.
3. Crear una etiqueta anotada `v2.2.4` firmada por una identidad autorizada y verificada por GitHub; no hay una clave de firma configurada en este sandbox.
4. Publicar el borrador sólo cuando esos controles estén acreditados. Los workflows de publicación npm y anuncios quedan restringidos al repositorio original; no deben enviar este fork a su espacio de publicación.

La revisión automática de CodeRabbit está bloqueada por autorización del repositorio. Las revisiones internas y pruebas de regresión no se presentan como sustituto de los controles remotos.
