import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';
import { createClient } from 'redis';
import { apiReference } from '@scalar/express-api-reference';
import { rateLimit } from 'express-rate-limit'; // 1. Import rate limiter
import { RedisStore } from 'rate-limit-redis';   // 2. Import Redis store for limiter

const { Pool } = pkg;

const app = express();
app.use(express.json());
app.use(cors());

// ==========================================
// DATABASE & REDIS SETUP
// ==========================================
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("❌ ERROR: DATABASE_URL is undefined in environment variables!");
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Connect to Redis (Used for both stock decrement and rate-limiting)
const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect().catch((err) => console.error('Redis Connection Error:', err));


// ==========================================
// 🛡️ RATE LIMITER MIDDLEWARE (BOT PROTECTION)
// ==========================================
// Why: This restricts how many times a single user/IP can hit the checkout route.
// It prevents automated scripts from spamming your server and crashing the flash sale.
const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000, // Time window: 1 minute (60,000 milliseconds)
  max: 5,             // Max limit: Each IP/User can only make 5 checkout attempts per minute
  standardHeaders: true, // Return standard rate limit info in the `RateLimit-*` headers
  legacyHeaders: false,  // Disable the old `X-RateLimit-*` headers

  // Store the request counts in Redis so it works globally across your server
  store: new RedisStore({
    sendCommand: (...args) => redis.sendCommand(args),
  }),

  // What to return when a bot/user exceeds the limit
  handler: (req, res) => {
    return res.status(429).json({
      error: 'Too many checkout attempts! Please slow down and try again in a minute.',
    });
  },
});


// ==========================================
// OPENAPI SPECIFICATION (For Scalar Docs)
// ==========================================
app.get('/openapi.json', (req, res) => {
  res.json({
    openapi: '3.0.0',
    info: {
      title: 'FlashSale & Ticketing Engine API',
      version: '1.0.0',
      description: 'High-concurrency flash sale backend protected by Redis atomic counters and rate limiters.',
    },
    servers: [{ url: 'http://localhost:4000', description: 'Local server' }],
    paths: {
      '/api/events': {
        post: {
          summary: 'Create a new flash sale event',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    title: { type: 'string', example: 'Summer Music Festival' },
                    totalTickets: { type: 'integer', example: 100 },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'Event created successfully' },
            '500': { description: 'Server error' }
          },
        },
      },
      '/api/checkout': {
        post: {
          summary: 'Execute high-concurrency atomic checkout (Protected by Rate Limiter)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    userId: { type: 'string', example: 'user_9876' },
                    eventId: { type: 'string', example: 'evt_uuid_here' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Ticket successfully booked!' },
            '400': { description: 'Sold Out!' },
            '429': { description: 'Too many requests (Rate limit triggered)' },
            '500': { description: 'Server error' }
          },
        },
      },
    },
  });
});

// Scalar UI Route
app.use(
  '/reference',
  apiReference({
    url: '/openapi.json',
    theme: 'purple',
  })
);


// ==========================================
// APPLICATION ROUTES
// ==========================================

// 1. Create Event Route
app.post('/api/events', async (req, res) => {
  try {
    const { title, totalTickets } = req.body;

    // Save event to PostgreSQL via Prisma
    const event = await prisma.event.create({ data: { title, totalTickets } });

    // Set the initial ticket stock counter in Redis memory
    await redis.set(`event:${event.id}:stock`, totalTickets);

    return res.status(201).json({ message: 'Event created!', event });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to create event' });
  }
});

// 2. Checkout Route (Protected with checkoutLimiter middleware)
// Notice how `checkoutLimiter` is placed right before the async handler function!
app.post('/api/checkout', checkoutLimiter, async (req, res) => {
  const { userId, eventId } = req.body;
  const stockKey = `event:${eventId}:stock`;

  try {
    // Atomically decrement stock in Redis memory (lightning fast, prevents race conditions)
    const remainingStock = await redis.decr(stockKey);

    // If stock drops below 0, we oversold! Roll it back and reject.
    if (remainingStock < 0) {
      await redis.incr(stockKey); // Roll back the decrement
      return res.status(400).json({ error: 'Sold Out!' });
    }

    // If stock was available, record the permanent order in PostgreSQL
    const order = await prisma.order.create({ data: { userId, eventId } });

    return res.status(200).json({
      message: 'Booked!',
      orderId: order.id,
      remainingStock
    });
  } catch (error) {
    // Safety fallback: if database fails, refund the ticket count back to Redis
    await redis.incr(stockKey);
    console.error(error);
    return res.status(200).json({ error: 'Checkout processing failed' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 FlashTicket backend running on port ${PORT}`);
  console.log(`🛡️ Rate Limiting active on /api/checkout (Max 5 requests/min per IP)`);
  console.log(`📖 Scalar API documentation live at http://localhost:${PORT}/reference`);
});