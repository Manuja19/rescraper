import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getReanimeEpisodes, getReanimeWatch } from './scraper';

const app = new Hono();

// Enable CORS
app.use('*', cors());

// Health check
app.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'ReAnime Scraper',
    endpoints: [
      'GET /api/episodes?anilistId=20',
      'GET /api/watch?anilistId=20&ep=1&type=sub',
      'GET /api/health'
    ],
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get episodes
app.get('/api/episodes', async (c) => {
  const anilistId = c.req.query('anilistId');
  if (!anilistId) {
    return c.json({ error: 'Missing ?anilistId=' }, 400);
  }
  
  try {
    const data = await getReanimeEpisodes(parseInt(anilistId));
    return c.json(data);
  } catch (e: any) {
    console.error('[API] Episodes error:', e);
    return c.json({ error: e.message }, 500);
  }
});

// Get watch stream
app.get('/api/watch', async (c) => {
  const anilistId = c.req.query('anilistId');
  const ep = c.req.query('ep');
  const type = c.req.query('type') || 'sub';
  
  if (!anilistId || !ep) {
    return c.json({ error: 'Missing ?anilistId= and ?ep=' }, 400);
  }
  
  const epNum = parseInt(ep);
  if (isNaN(epNum)) {
    return c.json({ error: 'ep must be a number' }, 400);
  }
  
  if (!['sub', 'dub'].includes(type)) {
    return c.json({ error: 'type must be sub or dub' }, 400);
  }
  
  try {
    const data = await getReanimeWatch(parseInt(anilistId), type as 'sub' | 'dub', epNum);
    return c.json(data);
  } catch (e: any) {
    console.error('[API] Watch error:', e);
    return c.json({ error: e.message }, 500);
  }
});

// Export the app
export default app;
