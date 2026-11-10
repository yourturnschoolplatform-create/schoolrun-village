import serverless from 'serverless-http';
import { createApp } from '../server/index.js';

// server/index exports createApp() (not a default Express app).
const app = await createApp({ serveClient: false });

export default serverless(app);
