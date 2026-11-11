import { z } from "zod";

// Extension CSP forbids dynamic code compilation. Use Zod's interpreted parser.
z.config({ jitless: true });

export { z };
