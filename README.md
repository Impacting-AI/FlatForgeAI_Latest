# FlatForge

React panel workspace + Python/OpenCascade reconstruction engine.

Copy `.env.example` to `.env`, replace both example secrets, then run:

```sh
docker compose up --build -d
```

Open **http://localhost:8080**. The full local stack supports persistent projects,
DXF uploads, drawing-evidence review, actual STEP/GLB/STL generation and downloads.
DWG input/export additionally requires an installed ODA File Converter.

The hosted site has three real reference conversions to explore and becomes a
live workspace after connecting the Python API. Native CAD does not run inside
a Cloudflare Worker.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for setup, drawing protocol, algorithms,
validation, limitations, scaling, authentication boundaries and source layout.
