// Worker entry for the independent Halloween Check-in service.
// Static pages come from the assets binding; /api/* and /media/* are handled here.

import { createWorkerHandler } from "./router.js";

const handle = createWorkerHandler();

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};
