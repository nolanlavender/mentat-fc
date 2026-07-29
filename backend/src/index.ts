import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { apiRouter } from './routes/index.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'unreachable' });
  }
});

app.use('/api', apiRouter);

// Must be registered after all routes -- Express matches error middleware by
// position (4-arg signature), not by path, so anything mounted after this
// point would never see errors from routes above it.
app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`Backend listening on http://localhost:${env.port}`);
});
