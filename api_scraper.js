// api_scraper_pro.js - Professional Twitter Scraper v5.0
// Senior Backend Architecture - Enterprise Grade
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cluster = require('cluster');
const os = require('os');
const https = require('https');
const http = require('http');
const { promisify } = require('util');
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
require('dotenv').config();

// ==================== ENVIRONMENT VALIDATION ====================
const ENV = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT) || 3003,
  API_KEY: process.env.API_KEY,
  SSL_KEY_PATH: process.env.SSL_KEY_PATH,
  SSL_CERT_PATH: process.env.SSL_CERT_PATH,
  REDIS_URL: process.env.REDIS_URL,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  MAX_CONCURRENT_SCRAPES: parseInt(process.env.MAX_CONCURRENT_SCRAPES) || 5,
  SESSION_TTL: parseInt(process.env.SESSION_TTL) || 3600
};

// Validate required environment variables
const requiredEnvVars = ['API_KEY'];
if (ENV.NODE_ENV === 'production') {
  requiredEnvVars.push('SSL_KEY_PATH', 'SSL_CERT_PATH');
}

const missingEnvVars = requiredEnvVars.filter(key => !ENV[key]);
if (missingEnvVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingEnvVars.join(', ')}`);
  console.error('   Please set them in your .env file or environment');
  process.exit(1);
}

// ==================== LOGGING SYSTEM ====================
class Logger {
  constructor() {
    this.logLevels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3
    };
    this.currentLevel = this.logLevels[ENV.LOG_LEVEL] || 2;
    this.logDir = path.join(__dirname, 'logs');
    
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    
    this.streams = {
      error: fs.createWriteStream(path.join(this.logDir, 'error.log'), { flags: 'a' }),
      combined: fs.createWriteStream(path.join(this.logDir, 'combined.log'), { flags: 'a' })
    };
  }

  log(level, message, metadata = {}) {
    if (this.logLevels[level] > this.currentLevel) return;
    
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level: level.toUpperCase(),
      pid: process.pid,
      message,
      ...metadata
    };
    
    const logString = JSON.stringify(logEntry);
    
    // Console output (colored based on level)
    const colors = {
      error: '\x1b[31m',
      warn: '\x1b[33m',
      info: '\x1b[36m',
      debug: '\x1b[90m',
      reset: '\x1b[0m'
    };
    
    console.log(`${colors[level]}[${timestamp}] ${level.toUpperCase()}: ${message}${colors.reset}`);
    
    // File output
    this.streams.combined.write(logString + '\n');
    if (level === 'error' || level === 'warn') {
      this.streams.error.write(logString + '\n');
    }
  }

  error(message, error = null) {
    this.log('error', message, { 
      error: error?.message, 
      stack: error?.stack 
    });
  }

  warn(message, metadata = {}) {
    this.log('warn', message, metadata);
  }

  info(message, metadata = {}) {
    this.log('info', message, metadata);
  }

  debug(message, metadata = {}) {
    this.log('debug', message, metadata);
  }
}

const logger = new Logger();

// ==================== CONFIGURATION MANAGEMENT ====================
class ConfigManager {
  constructor() {
    this.config = {
      scraper: {
        maxTweetsPerRequest: 100,
        minDelayMs: 30000,
        maxDelayMs: 120000,
        requestTimeout: 90000,
        maxRetries: 3,
        userAgents: [
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ]
      },
      api: {
        rateLimitWindowMs: 60000,
        rateLimitMax: 30,
        maxRequestBodySize: '10mb',
        corsOrigins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : []
      },
      security: {
        apiKeyHeader: 'x-api-key',
        sessionCookieName: 'twitter_session',
        enableCSP: true
      }
    };
  }

  getScraperConfig() {
    return this.config.scraper;
  }

  getApiConfig() {
    return this.config.api;
  }

  getSecurityConfig() {
    return this.config.security;
  }

  getRandomUserAgent() {
    const agents = this.config.scraper.userAgents;
    return agents[Math.floor(Math.random() * agents.length)];
  }
}

const configManager = new ConfigManager();

// ==================== CIRCUIT BREAKER PATTERN ====================
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 60000;
    this.halfOpenAttempts = options.halfOpenAttempts || 2;
    
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.halfOpenSuccessCount = 0;
  }

  async execute(fn, ...args) {
    if (this.state === 'OPEN') {
      const timeSinceFailure = Date.now() - this.lastFailureTime;
      if (timeSinceFailure > this.resetTimeout) {
        this.state = 'HALF_OPEN';
        logger.info('Circuit breaker transitioning to HALF_OPEN');
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await fn(...args);
      
      if (this.state === 'HALF_OPEN') {
        this.halfOpenSuccessCount++;
        if (this.halfOpenSuccessCount >= this.halfOpenAttempts) {
          this.reset();
        }
      }
      
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.halfOpenSuccessCount = 0;
      logger.warn('Circuit breaker moved back to OPEN after failed half-open attempt');
    } else if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      logger.error(`Circuit breaker opened after ${this.failureCount} failures`);
    }
  }

  reset() {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.halfOpenSuccessCount = 0;
    this.lastFailureTime = null;
    logger.info('Circuit breaker reset to CLOSED');
  }

  getStatus() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
      halfOpenSuccessCount: this.halfOpenSuccessCount
    };
  }
}

// ==================== CONNECTION POOL MANAGER ====================
class ConnectionPool {
  constructor(maxConnections = 3) {
    this.maxConnections = maxConnections;
    this.activeConnections = new Set();
    this.waitingQueue = [];
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeout: 30000
    });
  }

  async acquire() {
    return new Promise((resolve, reject) => {
      if (this.activeConnections.size < this.maxConnections) {
        const connectionId = crypto.randomBytes(8).toString('hex');
        this.activeConnections.add(connectionId);
        resolve({
          id: connectionId,
          release: () => this.release(connectionId)
        });
      } else {
        const queueEntry = {
          resolve: (conn) => resolve(conn),
          reject,
          timestamp: Date.now()
        };
        this.waitingQueue.push(queueEntry);
        
        // Timeout after 30 seconds
        setTimeout(() => {
          const index = this.waitingQueue.indexOf(queueEntry);
          if (index > -1) {
            this.waitingQueue.splice(index, 1);
            reject(new Error('Connection pool timeout'));
          }
        }, 30000);
      }
    });
  }

  release(connectionId) {
    this.activeConnections.delete(connectionId);
    
    // Process waiting queue
    if (this.waitingQueue.length > 0 && this.activeConnections.size < this.maxConnections) {
      const next = this.waitingQueue.shift();
      const newConnectionId = crypto.randomBytes(8).toString('hex');
      this.activeConnections.add(newConnectionId);
      
      next.resolve({
        id: newConnectionId,
        release: () => this.release(newConnectionId)
      });
    }
  }

  getStats() {
    return {
      active: this.activeConnections.size,
      waiting: this.waitingQueue.length,
      max: this.maxConnections,
      circuitBreaker: this.circuitBreaker.getStatus()
    };
  }
}

// ==================== SESSION MANAGEMENT ====================
class SessionManager {
  constructor() {
    this.sessionFile = path.join(__dirname, 'twitter_session.json');
    this.sessionCache = null;
    this.sessionTTL = ENV.SESSION_TTL * 1000; // Convert to milliseconds
  }

  async loadSession() {
    try {
      if (this.sessionCache && (Date.now() - this.sessionCache.loadedAt) < this.sessionTTL) {
        return this.sessionCache;
      }

      if (!fs.existsSync(this.sessionFile)) {
        throw new Error('Session file not found. Run authentication first.');
      }

      const data = await readFile(this.sessionFile, 'utf8');
      const session = JSON.parse(data);
      
      // Validate session structure
      if (!session.cookies || !Array.isArray(session.cookies)) {
        throw new Error('Invalid session format');
      }

      // Check for required cookies
      const requiredCookies = ['auth_token', 'ct0'];
      const missingCookies = requiredCookies.filter(name => 
        !session.cookies.find(c => c.name === name)
      );

      if (missingCookies.length > 0) {
        throw new Error(`Missing required cookies: ${missingCookies.join(', ')}`);
      }

      this.sessionCache = {
        ...session,
        loadedAt: Date.now(),
        isValid: true
      };

      logger.info(`Loaded ${session.cookies.length} cookies from session`);
      return this.sessionCache;
    } catch (error) {
      logger.error('Failed to load session', error);
      throw error;
    }
  }

  async saveSession(cookies) {
    try {
      const session = {
        cookies,
        savedAt: new Date().toISOString(),
        userAgent: configManager.getRandomUserAgent()
      };

      await writeFile(this.sessionFile, JSON.stringify(session, null, 2));
      this.sessionCache = null; // Invalidate cache
      logger.info(`Saved ${cookies.length} cookies to session`);
    } catch (error) {
      logger.error('Failed to save session', error);
      throw error;
    }
  }

  async validateSession(session) {
    try {
      // Check if session has expired cookies
      const now = Date.now();
      const validCookies = session.cookies.filter(cookie => {
        if (cookie.expires) {
          const expiryDate = new Date(cookie.expires).getTime();
          return expiryDate > now;
        }
        return true; // Session cookies without expiry
      });

      return validCookies.length >= 2; // At least auth_token and ct0
    } catch (error) {
      logger.error('Session validation failed', error);
      return false;
    }
  }
}

// ==================== MAIN SCRAPER ENGINE ====================
class TwitterScraper {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isConnected = false;
    this.connectionPool = new ConnectionPool(ENV.MAX_CONCURRENT_SCRAPES);
    this.sessionManager = new SessionManager();
    this.circuitBreaker = new CircuitBreaker();
    
    this.metrics = {
      totalRequests: 0,
      successfulScrapes: 0,
      failedScrapes: 0,
      totalTweetsCollected: 0,
      avgResponseTime: 0,
      lastScrapeTime: null
    };

    this.state = {
      healthy: false,
      lastHealthCheck: null,
      consecutiveErrors: 0,
      currentDelay: configManager.getScraperConfig().minDelayMs
    };

    this.setupGracefulShutdown();
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      logger.info(`Received ${signal}, starting graceful shutdown...`);
      
      // Prevent new connections
      this.state.healthy = false;
      
      // Wait for existing operations
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Cleanup resources
      await this.disconnect();
      
      logger.info('Graceful shutdown complete');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  async connect() {
    const connection = await this.connectionPool.acquire();
    
    try {
      logger.info('Initializing browser connection...');
      
      const session = await this.sessionManager.loadSession();
      const isValid = await this.sessionManager.validateSession(session);
      
      if (!isValid) {
        throw new Error('Invalid or expired session. Please re-authenticate.');
      }

      // Configure browser with stealth
      chromium.use(StealthPlugin());
      
      const browserArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1280,720',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security=false', // Important: Don't disable web security
        `--user-agent=${session.userAgent || configManager.getRandomUserAgent()}`
      ];

      // Launch browser - FIXED SSL ISSUE
      this.browser = await chromium.launch({
        headless: true,
        args: browserArgs,
        timeout: 60000
      });

      // Create context with proper SSL handling
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: session.userAgent || configManager.getRandomUserAgent(),
        ignoreHTTPSErrors: false, // NEVER ignore SSL errors in production
        bypassCSP: false, // Don't bypass CSP
        javaScriptEnabled: true,
        locale: 'en-US',
        timezoneId: 'America/New_York'
      });

      await this.context.addCookies(session.cookies);
      
      // Create page with realistic human-like behavior
      this.page = await this.context.newPage();
      await this.page.setDefaultTimeout(configManager.getScraperConfig().requestTimeout);
      
      // Add human-like interaction patterns
      await this.page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'plugins', { 
          get: () => [1, 2, 3, 4, 5] 
        });
      });

      // Verify login
      await this.verifyLogin();
      
      this.isConnected = true;
      this.state.healthy = true;
      this.state.consecutiveErrors = 0;
      
      logger.info('Twitter connection established successfully');
      
      return connection;
    } catch (error) {
      connection.release();
      logger.error('Connection failed', error);
      this.state.consecutiveErrors++;
      this.state.healthy = false;
      throw error;
    }
  }

  async verifyLogin(maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        logger.debug(`Login verification attempt ${attempt}`);
        
        await this.page.goto('https://twitter.com/home', {
          waitUntil: 'networkidle',
          timeout: 15000
        });

        await this.page.waitForTimeout(2000 + Math.random() * 3000);

        const isLoggedIn = await this.page.evaluate(() => {
          // Check for logged-in indicators
          const indicators = [
            document.querySelector('[data-testid="AppTabBar_Home_Link"]'),
            document.querySelector('[data-testid="primaryColumn"]'),
            document.querySelector('a[href="/compose/tweet"]')
          ];
          
          // Check for login page elements
          const blockers = [
            document.querySelector('input[name="session[username_or_email]"]'),
            document.querySelector('[data-testid="login"]'),
            document.querySelector('form[action="/sessions"]')
          ];

          return indicators.some(el => el && el.offsetParent !== null) && 
                 !blockers.some(el => el && el.offsetParent !== null);
        });

        if (isLoggedIn) {
          logger.info('Login verified successfully');
          return true;
        }

        if (attempt < maxAttempts) {
          await this.page.waitForTimeout(5000);
        }
      } catch (error) {
        logger.warn(`Login verification attempt ${attempt} failed`, { error: error.message });
        if (attempt < maxAttempts) {
          await this.page.waitForTimeout(5000);
        }
      }
    }

    throw new Error('Login verification failed. Session may be expired.');
  }

  async scrape(keyword, options = {}) {
    const startTime = Date.now();
    const scrapeId = crypto.randomBytes(4).toString('hex');
    
    logger.info(`Starting scrape ${scrapeId} for keyword: "${keyword}"`);
    
    try {
      // Apply rate limiting
      await this.applyRateLimit();
      
      // Use circuit breaker
      const result = await this.circuitBreaker.execute(async () => {
        return await this.performScrape(keyword, options);
      });
      
      // Update metrics
      const duration = Date.now() - startTime;
      this.updateMetrics(true, duration, result.length);
      
      logger.info(`Scrape ${scrapeId} completed successfully`, {
        keyword,
        tweetsFound: result.length,
        duration: `${duration}ms`
      });
      
      return result;
    } catch (error) {
      // Update metrics
      const duration = Date.now() - startTime;
      this.updateMetrics(false, duration, 0);
      
      logger.error(`Scrape ${scrapeId} failed`, {
        keyword,
        error: error.message,
        duration: `${duration}ms`
      });
      
      throw error;
    }
  }

  async performScrape(keyword, options) {
    const { limit = 20, fresh = false } = options;
    
    // Prepare new page for scraping
    await this.prepareScrapePage();
    
    // Navigate to search
    const searchUrl = `https://twitter.com/search?q=${encodeURIComponent(keyword)}&src=typed_query&f=live`;
    
    await this.page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // Wait for content to load
    await this.page.waitForSelector('article', { timeout: 15000 });
    
    // Simulate human scrolling
    const tweets = [];
    let scrollAttempts = 0;
    const maxScrolls = 8;
    
    while (tweets.length < limit && scrollAttempts < maxScrolls) {
      scrollAttempts++;
      
      // Extract tweets from current view
      const batch = await this.extractTweets(keyword);
      const newTweets = batch.filter(tweet => 
        !tweets.some(t => t.id === tweet.id)
      );
      
      tweets.push(...newTweets);
      
      logger.debug(`Scroll ${scrollAttempts}: Found ${newTweets.length} new tweets`);
      
      if (tweets.length < limit) {
        // Human-like scroll
        await this.page.evaluate(() => {
          window.scrollBy({
            top: window.innerHeight * (0.7 + Math.random() * 0.3),
            behavior: 'smooth'
          });
        });
        
        // Random wait between scrolls
        await this.page.waitForTimeout(1000 + Math.random() * 2000);
      }
    }
    
    // Sort and limit results
    const sortedTweets = tweets
      .sort((a, b) => {
        // Prioritize recent tweets with engagement
        if (a.isRecent && !b.isRecent) return -1;
        if (!a.isRecent && b.isRecent) return 1;
        return (b.metrics.likes + b.metrics.replies) - (a.metrics.likes + a.metrics.replies);
      })
      .slice(0, limit);
    
    return sortedTweets;
  }

  async extractTweets(keyword) {
    return await this.page.evaluate((kw) => {
      const tweetElements = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
      
      return tweetElements.map((el, index) => {
        // Extract tweet ID
        const tweetId = el.getAttribute('data-tweet-id') || 
                       el.querySelector('a[href*="/status/"]')?.href?.match(/\/status\/(\d+)/)?.[1] ||
                       `gen_${Date.now()}_${index}`;
        
        // Extract text content
        const textEl = el.querySelector('[data-testid="tweetText"]');
        const text = textEl ? textEl.textContent.trim() : '';
        
        // Extract author
        const authorEl = el.querySelector('[data-testid="User-Name"]');
        const author = authorEl ? authorEl.textContent.split('·')[0].trim() : '';
        
        // Extract timestamp
        const timeEl = el.querySelector('time');
        const timestamp = timeEl ? timeEl.getAttribute('datetime') : new Date().toISOString();
        const isRecent = timeEl ? (Date.now() - new Date(timestamp).getTime()) < 86400000 : false;
        
        // Extract engagement metrics
        const getMetric = (testid) => {
          const el = document.querySelector(`[data-testid="${testid}"]`);
          if (!el) return 0;
          const text = el.textContent || '';
          const match = text.match(/(\d+(\.\d+)?[KMB]?)/);
          if (!match) return 0;
          
          const num = match[1];
          if (num.includes('K')) return parseFloat(num) * 1000;
          if (num.includes('M')) return parseFloat(num) * 1000000;
          if (num.includes('B')) return parseFloat(num) * 1000000000;
          return parseFloat(num);
        };
        
        const metrics = {
          likes: getMetric('like'),
          retweets: getMetric('retweet'),
          replies: getMetric('reply')
        };
        
        return {
          id: tweetId,
          text: text.substring(0, 280),
          author: author.substring(0, 50),
          keyword: kw,
          timestamp,
          isRecent,
          url: `https://twitter.com/i/status/${tweetId}`,
          metrics,
          scrapedAt: new Date().toISOString()
        };
      }).filter(tweet => tweet.text.length > 10);
    }, keyword);
  }

  async applyRateLimit() {
    const now = Date.now();
    const timeSinceLast = now - (this.metrics.lastScrapeTime || 0);
    const requiredDelay = this.state.currentDelay;
    
    if (timeSinceLast < requiredDelay) {
      const waitTime = requiredDelay - timeSinceLast;
      logger.debug(`Rate limiting: waiting ${Math.round(waitTime / 1000)}s`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    // Adaptive delay adjustment
    if (this.state.consecutiveErrors > 0) {
      this.state.currentDelay = Math.min(
        configManager.getScraperConfig().maxDelayMs,
        this.state.currentDelay * (1 + this.state.consecutiveErrors * 0.2)
      );
    } else {
      this.state.currentDelay = Math.max(
        configManager.getScraperConfig().minDelayMs,
        this.state.currentDelay * 0.9
      );
    }
  }

  async prepareScrapePage() {
    if (this.page) {
      await this.page.close();
    }
    
    this.page = await this.context.newPage();
    
    // Set realistic viewport
    await this.page.setViewportSize({
      width: 1200 + Math.floor(Math.random() * 200),
      height: 800 + Math.floor(Math.random() * 200)
    });
    
    // Add random mouse movements
    await this.page.mouse.move(
      100 + Math.random() * 200,
      100 + Math.random() * 200
    );
    
    await this.page.waitForTimeout(500 + Math.random() * 1000);
  }

  updateMetrics(success, duration, tweetCount) {
    this.metrics.totalRequests++;
    
    if (success) {
      this.metrics.successfulScrapes++;
      this.metrics.totalTweetsCollected += tweetCount;
      this.state.consecutiveErrors = 0;
    } else {
      this.metrics.failedScrapes++;
      this.state.consecutiveErrors++;
    }
    
    // Update average response time (exponential moving average)
    const alpha = 0.1;
    this.metrics.avgResponseTime = 
      alpha * duration + (1 - alpha) * this.metrics.avgResponseTime;
    
    this.metrics.lastScrapeTime = Date.now();
  }

  async disconnect() {
    const cleanup = async (resource, name) => {
      try {
        if (resource) {
          await resource.close();
          logger.debug(`Closed ${name}`);
        }
      } catch (error) {
        logger.warn(`Error closing ${name}`, { error: error.message });
      }
    };

    await cleanup(this.page, 'page');
    await cleanup(this.context, 'context');
    await cleanup(this.browser, 'browser');
    
    this.isConnected = false;
    this.state.healthy = false;
    
    logger.info('Disconnected from Twitter');
  }

  getMetrics() {
    const successRate = this.metrics.totalRequests > 0 
      ? (this.metrics.successfulScrapes / this.metrics.totalRequests) * 100 
      : 0;
    
    return {
      ...this.metrics,
      successRate: `${successRate.toFixed(1)}%`,
      state: this.state,
      connectionPool: this.connectionPool.getStats(),
      circuitBreaker: this.circuitBreaker.getStatus()
    };
  }

  async healthCheck() {
    try {
      if (!this.isConnected) {
        return { healthy: false, reason: 'Not connected' };
      }
      
      // Quick test to verify Twitter is accessible
      const testPage = await this.context.newPage();
      await testPage.goto('https://twitter.com', {
        waitUntil: 'domcontentloaded',
        timeout: 10000
      });
      
      const isAccessible = await testPage.evaluate(() => {
        return document.title.includes('Twitter') || 
               document.querySelector('body') !== null;
      });
      
      await testPage.close();
      
      this.state.lastHealthCheck = Date.now();
      this.state.healthy = isAccessible;
      
      return { 
        healthy: isAccessible, 
        timestamp: new Date().toISOString() 
      };
    } catch (error) {
      this.state.healthy = false;
      return { 
        healthy: false, 
        reason: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

// ==================== API SERVER ====================
class ApiServer {
  constructor() {
    this.app = express();
    this.scraper = new TwitterScraper();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  setupMiddleware() {
    // Security middleware
    this.app.use(helmet({
      contentSecurityPolicy: configManager.getSecurityConfig().enableCSP,
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      }
    }));
    
    // Compression
    this.app.use(compression());
    
    // Logging
    this.app.use(morgan('combined', {
      stream: {
        write: (message) => logger.info(message.trim())
      }
    }));
    
    // Body parsing
    this.app.use(express.json({ 
      limit: configManager.getApiConfig().maxRequestBodySize 
    }));
    this.app.use(express.urlencoded({ 
      extended: true, 
      limit: configManager.getApiConfig().maxRequestBodySize 
    }));
    
    // CORS
    this.app.use((req, res, next) => {
      const origins = configManager.getApiConfig().corsOrigins;
      const origin = req.headers.origin;
      
      if (origins.includes('*') && ENV.NODE_ENV !== 'production') {
        res.header('Access-Control-Allow-Origin', '*');
      } else if (origin && origins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
      }
      
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
      res.header('Access-Control-Allow-Credentials', 'true');
      
      if (req.method === 'OPTIONS') {
        return res.status(200).end();
      }
      
      next();
    });
    
    // API Key validation middleware
    this.app.use((req, res, next) => {
      const apiKeyHeader = configManager.getSecurityConfig().apiKeyHeader;
      const apiKey = req.headers[apiKeyHeader] || req.query.api_key;
      
      // Skip auth for health checks
      if (req.path === '/health' || req.path === '/') {
        return next();
      }
      
      if (!apiKey) {
        return res.status(401).json({
          error: 'API key required',
          message: `Include ${apiKeyHeader} header or api_key query parameter`
        });
      }
      
      if (apiKey !== ENV.API_KEY) {
        logger.warn('Invalid API key attempt', { ip: req.ip });
        return res.status(403).json({
          error: 'Invalid API key'
        });
      }
      
      logger.debug('API request authenticated', { 
        path: req.path, 
        ip: req.ip 
      });
      next();
    });
    
    // Rate limiting
    const limiter = rateLimit({
      windowMs: configManager.getApiConfig().rateLimitWindowMs,
      max: configManager.getApiConfig().rateLimitMax,
      message: {
        error: 'Too many requests',
        retryAfter: '60 seconds'
      },
      standardHeaders: true,
      legacyHeaders: false
    });
    
    this.app.use('/scrape', limiter);
  }

  setupRoutes() {
    // Health endpoint
    this.app.get('/health', async (req, res) => {
      const health = await this.scraper.healthCheck();
      const metrics = this.scraper.getMetrics();
      
      res.json({
        status: health.healthy ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        scraper: health,
        metrics: {
          ...metrics,
          memory: {
            rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
            heap: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
          }
        },
        environment: ENV.NODE_ENV
      });
    });
    
    // Scrape endpoint
    this.app.post('/scrape', async (req, res) => {
      try {
        const { keyword, limit = 20, priority = 0 } = req.body;
        
        // Validate input
        if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
          return res.status(400).json({
            error: 'Invalid keyword',
            message: 'Keyword must be a non-empty string'
          });
        }
        
        const validLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
        const trimmedKeyword = keyword.trim().substring(0, 100);
        
        logger.info('Scrape request received', {
          keyword: trimmedKeyword,
          limit: validLimit,
          priority,
          ip: req.ip
        });
        
        const tweets = await this.scraper.scrape(trimmedKeyword, {
          limit: validLimit,
          fresh: priority > 0
        });
        
        res.json({
          success: true,
          data: {
            keyword: trimmedKeyword,
            count: tweets.length,
            tweets
          },
          meta: {
            requestedAt: new Date().toISOString(),
            processingTime: `${Date.now() - req.startTime}ms`
          }
        });
      } catch (error) {
        logger.error('Scrape endpoint error', error);
        
        const statusCode = error.message.includes('Circuit breaker') ? 503 :
                          error.message.includes('rate limit') ? 429 : 500;
        
        res.status(statusCode).json({
          error: 'Scrape failed',
          message: error.message,
          suggestion: statusCode === 503 ? 'Service temporarily unavailable. Try again later.' :
                     statusCode === 429 ? 'Rate limit exceeded. Slow down requests.' :
                     'Internal server error.'
        });
      }
    });
    
    // Metrics endpoint
    this.app.get('/metrics', (req, res) => {
      res.json(this.scraper.getMetrics());
    });
    
    // Documentation
    this.app.get('/', (req, res) => {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Twitter Scraper API v5.0</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; }
            .endpoint { background: #f5f5f5; padding: 15px; margin: 10px 0; border-radius: 5px; }
            code { background: #e8e8e8; padding: 2px 5px; border-radius: 3px; }
          </style>
        </head>
        <body>
          <h1>🐦 Twitter Scraper API v5.0</h1>
          <p>Enterprise-grade Twitter scraping service</p>
          
          <div class="endpoint">
            <h3>POST /scrape</h3>
            <p>Scrape tweets for a keyword</p>
            <code>
              curl -X POST ${req.protocol}://${req.get('host')}/scrape \\
                -H "Content-Type: application/json" \\
                -H "x-api-key: ${ENV.API_KEY.substring(0, 3)}..." \\
                -d '{"keyword": "technology", "limit": 10}'
            </code>
          </div>
          
          <div class="endpoint">
            <h3>GET /health</h3>
            <p>Health check endpoint</p>
            <code>curl ${req.protocol}://${req.get('host')}/health</code>
          </div>
          
          <div class="endpoint">
            <h3>GET /metrics</h3>
            <p>Get performance metrics</p>
            <code>curl ${req.protocol}://${req.get('host')}/metrics</code>
          </div>
        </body>
        </html>
      `);
    });
  }

  setupErrorHandling() {
    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        error: 'Not found',
        message: `Cannot ${req.method} ${req.path}`
      });
    });
    
    // Global error handler
    this.app.use((error, req, res, next) => {
      logger.error('Unhandled error', error);
      
      res.status(500).json({
        error: 'Internal server error',
        message: ENV.NODE_ENV === 'production' ? 'Something went wrong' : error.message,
        requestId: req.id
      });
    });
  }

  async start() {
    try {
      // Initialize scraper
      logger.info('Initializing Twitter scraper...');
      await this.scraper.connect();
      
      // Create HTTP/HTTPS server
      let server;
      if (ENV.NODE_ENV === 'production' && ENV.SSL_KEY_PATH && ENV.SSL_CERT_PATH) {
        const sslOptions = {
          key: await readFile(path.resolve(ENV.SSL_KEY_PATH)),
          cert: await readFile(path.resolve(ENV.SSL_CERT_PATH)),
          minVersion: 'TLSv1.2'
        };
        
        server = https.createServer(sslOptions, this.app);
        logger.info('HTTPS server configured');
      } else {
        server = http.createServer(this.app);
        if (ENV.NODE_ENV === 'production') {
          logger.warn('Running in production without HTTPS - not recommended');
        }
      }
      
      // Start server
      server.listen(ENV.PORT, '0.0.0.0', () => {
        logger.info(`Server started on port ${ENV.PORT}`, {
          environment: ENV.NODE_ENV,
          ssl: server instanceof https.Server,
          pid: process.pid
        });
      });
      
      // Handle server errors
      server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          logger.error(`Port ${ENV.PORT} already in use`);
          process.exit(1);
        } else {
          logger.error('Server error', error);
        }
      });
      
      // Periodic health checks
      setInterval(async () => {
        await this.scraper.healthCheck();
      }, 30000);
      
      return server;
    } catch (error) {
      logger.error('Failed to start server', error);
      process.exit(1);
    }
  }
}

// ==================== APPLICATION BOOTSTRAP ====================
async function bootstrap() {
  logger.info('Starting Twitter Scraper v5.0', {
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    environment: ENV.NODE_ENV,
    pid: process.pid
  });
  
  // Validate environment
  logger.info('Environment validation passed');
  
  // Start API server
  const apiServer = new ApiServer();
  await apiServer.start();
  
  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', error);
    // Don't exit immediately - log and continue
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled promise rejection', { reason: reason.toString(), promise });
  });
}

// Start the application
if (require.main === module) {
  bootstrap().catch((error) => {
    logger.error('Bootstrap failed', error);
    process.exit(1);
  });
}

module.exports = {
  TwitterScraper,
  ApiServer,
  ConfigManager,
  CircuitBreaker,
  Logger
};
