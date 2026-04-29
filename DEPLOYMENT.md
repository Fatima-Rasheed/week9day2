# Deployment Guide

## Production Deployment Checklist

### Pre-Deployment

- [ ] All tests passing
- [ ] Environment variables configured
- [ ] MongoDB production instance ready
- [ ] Anthropic API key valid and has credits
- [ ] CORS configured for production domain
- [ ] Error logging configured
- [ ] Rate limiting implemented (recommended)
- [ ] Security review completed

## Deployment Options

### Option 1: Traditional VPS (DigitalOcean, AWS EC2, etc.)

#### 1. Server Setup

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install MongoDB
wget -qO - https://www.mongodb.org/static/pgp/server-6.0.asc | sudo apt-key add -
echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu focal/mongodb-org/6.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-6.0.list
sudo apt update
sudo apt install -y mongodb-org
sudo systemctl start mongod
sudo systemctl enable mongod

# Install PM2 for process management
sudo npm install -g pm2
```

#### 2. Deploy Backend

```bash
# Clone repository
git clone <your-repo-url>
cd cricket-stats-ai/backend

# Install dependencies
npm install --production

# Create .env file
cat > .env << EOF
MONGODB_URI=mongodb://localhost:27017/cricket_stats
ANTHROPIC_API_KEY=your_production_key
PORT=3001
NODE_ENV=production
EOF

# Build
npm run build

# Start with PM2
pm2 start dist/main.js --name cricket-backend
pm2 save
pm2 startup
```

#### 3. Deploy Frontend

```bash
cd ../frontend

# Install dependencies
npm install --production

# Create .env.local
cat > .env.local << EOF
NEXT_PUBLIC_API_URL=https://api.yourdomain.com
EOF

# Build
npm run build

# Start with PM2
pm2 start npm --name cricket-frontend -- start
pm2 save
```

#### 4. Setup Nginx Reverse Proxy

```bash
sudo apt install -y nginx

# Backend config
sudo nano /etc/nginx/sites-available/cricket-backend
```

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# Frontend config
sudo nano /etc/nginx/sites-available/cricket-frontend
```

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# Enable sites
sudo ln -s /etc/nginx/sites-available/cricket-backend /etc/nginx/sites-enabled/
sudo ln -s /etc/nginx/sites-available/cricket-frontend /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

#### 5. Setup SSL with Let's Encrypt

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
sudo certbot --nginx -d api.yourdomain.com
```

### Option 2: Docker Deployment

#### 1. Backend Dockerfile

```dockerfile
# backend/Dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .
RUN npm run build

EXPOSE 3001

CMD ["node", "dist/main.js"]
```

#### 2. Frontend Dockerfile

```dockerfile
# frontend/Dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
```

#### 3. Docker Compose

```yaml
# docker-compose.yml
version: '3.8'

services:
  mongodb:
    image: mongo:6
    restart: always
    volumes:
      - mongodb_data:/data/db
    ports:
      - "27017:27017"

  backend:
    build: ./backend
    restart: always
    ports:
      - "3001:3001"
    environment:
      - MONGODB_URI=mongodb://mongodb:27017/cricket_stats
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - PORT=3001
    depends_on:
      - mongodb

  frontend:
    build: ./frontend
    restart: always
    ports:
      - "3000:3000"
    environment:
      - NEXT_PUBLIC_API_URL=http://localhost:3001
    depends_on:
      - backend

volumes:
  mongodb_data:
```

```bash
# Deploy with Docker Compose
docker-compose up -d
```

### Option 3: Cloud Platform (Vercel + MongoDB Atlas)

#### 1. MongoDB Atlas Setup

1. Create account at https://www.mongodb.com/cloud/atlas
2. Create a free cluster
3. Add database user
4. Whitelist IP addresses (0.0.0.0/0 for all)
5. Get connection string

#### 2. Import Data to Atlas

```bash
cd scripts
# Edit .env with Atlas connection string
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/cricket_stats
npm run import
```

#### 3. Deploy Backend (Railway/Render)

**Railway**:
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and deploy
cd backend
railway login
railway init
railway up
```

**Render**:
1. Connect GitHub repository
2. Create new Web Service
3. Build command: `cd backend && npm install && npm run build`
4. Start command: `cd backend && node dist/main.js`
5. Add environment variables

#### 4. Deploy Frontend (Vercel)

```bash
# Install Vercel CLI
npm install -g vercel

# Deploy
cd frontend
vercel login
vercel --prod
```

Or connect GitHub repository to Vercel dashboard.

## Environment Variables for Production

### Backend
```
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/cricket_stats
ANTHROPIC_API_KEY=sk-ant-api03-...
PORT=3001
NODE_ENV=production
CORS_ORIGIN=https://yourdomain.com
```

### Frontend
```
NEXT_PUBLIC_API_URL=https://api.yourdomain.com
```

## Security Hardening

### 1. Rate Limiting

Install in backend:
```bash
npm install @nestjs/throttler
```

```typescript
// app.module.ts
import { ThrottlerModule } from '@nestjs/throttler';

@Module({
  imports: [
    ThrottlerModule.forRoot({
      ttl: 60,
      limit: 10, // 10 requests per minute
    }),
  ],
})
```

### 2. Helmet (Security Headers)

```bash
npm install helmet
```

```typescript
// main.ts
import helmet from 'helmet';

app.use(helmet());
```

### 3. API Key Authentication

```typescript
// auth.guard.ts
@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['x-api-key'];
    return apiKey === process.env.API_KEY;
  }
}
```

### 4. Input Validation

Already implemented with `class-validator` in NestJS.

### 5. MongoDB Security

- Use strong passwords
- Enable authentication
- Use SSL/TLS connections
- Restrict network access
- Regular backups

## Monitoring & Logging

### 1. PM2 Monitoring

```bash
pm2 monit
pm2 logs cricket-backend
pm2 logs cricket-frontend
```

### 2. Application Logging

```typescript
// Use NestJS Logger
import { Logger } from '@nestjs/common';

private readonly logger = new Logger(LangGraphService.name);

this.logger.log('Processing question: ' + question);
this.logger.error('Error: ' + error.message);
```

### 3. Error Tracking (Sentry)

```bash
npm install @sentry/node
```

```typescript
// main.ts
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
});
```

## Performance Optimization

### 1. Caching (Redis)

```bash
npm install @nestjs/cache-manager cache-manager
npm install cache-manager-redis-store
```

```typescript
// Cache common queries
@Injectable()
export class ChatService {
  @Cacheable({ ttl: 300 }) // 5 minutes
  async processQuestion(question: string) {
    // ...
  }
}
```

### 2. Database Indexing

```javascript
// In MongoDB
db.odi.createIndex({ name: 1 });
db.odi.createIndex({ runs: -1 });
db.odi.createIndex({ country: 1 });
```

### 3. Frontend Optimization

- Enable Next.js image optimization
- Use static generation where possible
- Implement lazy loading
- Minimize bundle size

## Backup Strategy

### 1. MongoDB Backup

```bash
# Daily backup script
#!/bin/bash
DATE=$(date +%Y%m%d)
mongodump --uri="mongodb://localhost:27017/cricket_stats" --out="/backups/$DATE"
```

### 2. Automated Backups

```bash
# Add to crontab
crontab -e

# Daily at 2 AM
0 2 * * * /path/to/backup-script.sh
```

## Scaling Considerations

### Horizontal Scaling
- Use load balancer (Nginx, AWS ALB)
- Deploy multiple backend instances
- Use Redis for session management
- Implement queue system for heavy tasks

### Vertical Scaling
- Increase server resources
- Optimize MongoDB queries
- Use connection pooling
- Implement caching

## Cost Estimation

### Monthly Costs (Approximate)

**Option 1: VPS**
- DigitalOcean Droplet (2GB): $12/month
- MongoDB Atlas Free Tier: $0
- Domain: $12/year
- SSL: Free (Let's Encrypt)
- **Total: ~$13/month**

**Option 2: Cloud Platform**
- Vercel (Frontend): Free tier
- Railway (Backend): $5/month
- MongoDB Atlas: Free tier
- **Total: ~$5/month**

**Option 3: AWS**
- EC2 t3.small: $15/month
- MongoDB Atlas M10: $57/month
- Route 53: $1/month
- **Total: ~$73/month**

### Anthropic API Costs
- Claude Sonnet: ~$3 per million input tokens
- Average query: ~2000 tokens
- 1000 queries: ~$6
- Estimate based on usage

## Rollback Plan

### Quick Rollback

```bash
# PM2 rollback
pm2 stop cricket-backend
pm2 delete cricket-backend
cd /path/to/previous/version
pm2 start dist/main.js --name cricket-backend
```

### Database Rollback

```bash
# Restore from backup
mongorestore --uri="mongodb://localhost:27017/cricket_stats" /backups/20240428
```

## Health Checks

### Backend Health Endpoint

```typescript
// health.controller.ts
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      mongodb: 'connected',
    };
  }
}
```

### Monitoring Script

```bash
#!/bin/bash
# check-health.sh
RESPONSE=$(curl -s http://localhost:3001/health)
if [[ $RESPONSE == *"ok"* ]]; then
  echo "✓ Backend healthy"
else
  echo "✗ Backend down - restarting"
  pm2 restart cricket-backend
fi
```

## Post-Deployment

- [ ] Test all endpoints
- [ ] Verify SSL certificates
- [ ] Check logs for errors
- [ ] Monitor performance
- [ ] Set up alerts
- [ ] Document any issues
- [ ] Update DNS records
- [ ] Notify team/users
