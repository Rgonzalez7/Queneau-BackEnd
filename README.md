# Quenu — backend

API en Express + TypeScript. Fuente de verdad: cuotas, caducidad, muro de pago, desbloqueo.

## Correr

```bash
npm install
npm run dev      # tsx watch, puerto 4000
```

Build de producción:

```bash
npm run build    # tsc -> dist/
npm start        # node dist/server.js
```

## Estructura

```
src/
├── server.ts        # Express: rutas + CORS
└── lib/
    ├── types.ts      # tipos del dominio
    ├── constants.ts  # formatos, cuota, TTL, helpers
    ├── rules.ts      # reglas de negocio (cuota, caducidad, compra, leído)
    ├── generator.ts  # STUB del generador (gancho del modelo)
    ├── analyzer.ts   # STUB del extractor de gusto (gancho del modelo)
    └── db.ts         # almacenamiento (archivo JSON, swappable por DB real)
data/db.json          # estado (se crea solo)
```

## Endpoints

| método | ruta | qué hace |
|---|---|---|
| GET | /api/state | estado público (perfiles + historias con muro) |
| POST | /api/profiles | crear/editar perfil |
| DELETE | /api/profiles/:id | borrar perfil |
| POST | /api/profiles/extract | texto -> borrador de perfil de gusto |
| POST | /api/openings | generar apertura gratis |
| POST | /api/openings/extra | apertura extra (pago) |
| POST | /api/openings/:id/purchase | desbloquear libro |
| POST | /api/openings/:id/sequel | secuela |
| POST | /api/openings/:id/finish | marcar leído/no leído |

CORS permite el origen del frontend (`CORS_ORIGIN`, por defecto http://localhost:3000).
