// cerase-acp PoC v0.1 — entry point placeholder.
//
// The full wiring (config load → session manager → Discord adapter →
// streaming → send queue → optional test-injection HTTP server) lands
// in milestone M5 of devplan/v0.1.md. Until then, this file exists so
// the Docker build (M6) and `npm run build` (M1) have a target.

const pkgVersion = process.env.npm_package_version ?? "0.1.0-dev";
console.log(`cerase-acp ${pkgVersion} starting — bridge not yet implemented (see devplan/v0.1.md).`);
process.exit(0);
