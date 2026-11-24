import { writeFileSync } from "node:fs";

import { buildOpenApi, OPENAPI_PATH, serialize } from "./openapi.js";

writeFileSync(OPENAPI_PATH, serialize(buildOpenApi()));
console.log(`wrote ${OPENAPI_PATH}`);
