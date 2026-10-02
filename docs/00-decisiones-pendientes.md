# 00 · Decisiones

## ✅ Resueltas

| # | Decisión | Dónde quedó |
|---|---|---|
| **D-2** | La comida es **solo control de tiempo e incidencias** (salida → regreso → duración → exceso). No descuenta horas ni afecta pagos/nómina. Default **35 min**, configurable por negocio, sucursal y **empleado**. | RN-CAL-02 |
| **D-3** | Se registran los **minutos reales de retardo** (7:12 vs 7:00 = 12 min). La tolerancia solo decide si **genera incidencia** (7:08 no, 7:12 sí). | §9 |
| **D-6** | Checada **sin turno programado: se permite** y se marca "SIN TURNO PROGRAMADO" para revisión. | RN-EVT-06 |
| **D-7** | El encargado **corrige directamente**, solo en jornadas de su alcance, con **motivo obligatorio** y auditoría completa. Nunca se borra ni reemplaza en silencio la original. | RN-COR-04 |
| **D-9** | Jornada abierta = olvido de salida: **se detecta, se marca como incidencia y requiere corrección; el sistema nunca inventa una hora de salida.** Existe **hora de corte operativo por sucursal**. | §5 (RN-OPE) |
| **Multi-tenant** | Plataforma → Negocio → Sucursales → Empleados; `organization_id` en todo; aislamiento en backend **y** base de datos (RLS); usuario con varias sucursales sin duplicar cuenta; auditoría con negocio y sucursal. Fatboy = primer tenant. | §3 de reglas, §3 de modelo, §2 de arquitectura |

## ⏳ Pendientes (para revisar una por una)

Para cada una: propuesta (`default`) y un ejemplo. Respuesta rápida: "D-n ok" o "D-n: cambio X".

| # | Tema | Propuesta resumida |
|---|---|---|
| **D-1** | Zona horaria | `America/Mexico_City` por defecto del negocio; cada sucursal puede tener la suya |
| **D-4** | "No se presentó" y retardo grande | Tablero: "Retardo" tras la tolerancia; "No se presentó" a los 60 min. **Falta definitiva** solo al terminar el turno sin Entrada. Retardo grande **no** se vuelve falta (configurable, apagado) |
| **D-5** | Entrada anticipada | Se permite checar hasta 60 min antes del turno; se guarda la hora real |
| **D-8** | PIN | 6 dígitos, generado por el sistema, lo entrega encargado/admin; reinicio sí, cambio por el empleado no (por ahora) |
| **D-10** | Semana y periodos | Semana lunes–domingo (configurable por negocio); reportes por periodo libre con atajos (semana, quincena, mes) |
| **D-11** | Acceso al panel | Correo + contraseña; recuperación de contraseña la hace el admin (sin correo automático en el MVP) |
| **D-12** | Sin internet | MVP exige conexión; contingencia = corrección manual con motivo |
| **D-13** | ORM | Drizzle |
| **D-14** | Más de una comida | Una por jornada (configurable) |
| **D-15** | Encargados/dueños que también checan | Un usuario puede estar ligado a su ficha de empleado (opcional) |
| **D-16** | Idioma | UI en español, listo para otros idiomas; código en inglés |
| **D-17** *(nueva)* | Checar en sucursal sin asignación | Se permite y se marca para revisión (mismo criterio que D-6) |
| **D-18** *(nueva)* | Quién puede corregir a quién | Por sucursal **donde se trabajó**; nadie corrige su propia jornada |
| **D-19** *(nueva)* | Detalles multi-negocio | Usuario global con membresías; PIN único por negocio; alta de negocios por CLI; negocio por sesión/token (sin subdominios) |

El detalle con ejemplos de cada una se revisa en la conversación; al resolverlas se mueven a la tabla de arriba.

## Siguiente paso

1. Revisamos D-1, D-4, D-5, D-8, D-10…D-19.
2. Congelo reglas y modelo (v1.0).
3. Fase 0: monorepo, Docker, CI, migraciones, **roles de BD + RLS + contexto de negocio + pruebas de aislamiento**, auth con alcance de sucursales, auditoría base y CLI de alta de negocio.
