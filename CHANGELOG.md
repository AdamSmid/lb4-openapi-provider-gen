# Changelog

## 0.1.0

Initial standalone release.

- Generate typed LoopBack 4 service providers from OpenAPI 3.0 JSON and YAML.
- Expose typed API methods on both the service interface and provider class.
- Support connector response envelopes and transformed response bodies.
- Generate schema, request and response aliases using `openapi-typescript`.
- Preserve connector method naming and positional parameter order.
- Detect unsupported references, naming collisions and invalid CLI input.
- Protect existing output and provide `--check` for generated-file drift.
