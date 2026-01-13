// twitter_scraper_fixed.js - Complete Working Version
const { chromium } = require('playwright');
const express = require('express');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

class TwitterScraper {
    constructor() {
        this.browser = null;
        this.context = null;
        this.isConnected = false;
        this.sessionFile = 'twitter_session.json';
        
        console.log("🚀 Twitter Scraper v2.0 - Fixed for VPS");
    }
    
    async connect() {
        try {
            console.log('🔄 Starting browser...');
            
            // Browser args that work on VPS
            const browserArgs = [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1280,720',
                '--disable-blink-features=AutomationControlled',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ];
            
            this.browser = await chromium.launch({ 
                headless: 'new',  // Use new headless mode
                args: browserArgs
            });
            
            this.context = await this.browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                ignoreHTTPSErrors: false,
                javaScriptEnabled: true
            });
            
            // Load cookies if they exist
            if (fs.existsSync(this.sessionFile)) {
                console.log('📁 Loading cookies...');
                const session = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
                await this.context.addCookies(session.cookies);
                console.log(`✅ Loaded ${session.cookies.length} cookies`);
            } else {
                console.log('⚠️  No session file. Will try public access.');
            }
            
            // Test login
            await this.testLogin();
            
            this.isConnected = true;
            console.log('🎉 Connected successfully!');
            
        } catch (error) {
            console.error('❌ Connection failed:', error.message);
            await this.cleanup();
            throw error;
        }
    }
    
    async testLogin() {
        console.log('🔐 Testing Twitter access...');
        const page = await this.context.newPage();
        
        try {
            await page.goto('https://twitter.com/explore', {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
            
            // Wait for page to settle
            await page.waitForTimeout(3000);
            
            // Check if we can see tweets (logged in or public)
            const tweetCount = await page.evaluate(() => {
                const articles = document.querySelectorAll('article');
                return articles.length;
            });
            
            console.log(`📊 Found ${tweetCount} tweet elements on explore page`);
            
            if (tweetCount > 0) {
                console.log('✅ Can access Twitter content');
                await page.close();
                return true;
            }
            
            // Check for login page
            const isLoginPage = await page.evaluate(() => {
                return document.querySelector('input[name="session[username_or_email]"]') !== null ||
                       document.querySelector('[data-testid="login"]') !== null;
            });
            
            if (isLoginPage) {
                console.log('⚠️  Showing login page - session may be expired');
            }
            
            await page.close();
            return tweetCount > 0;
            
        } catch (error) {
            console.log('⚠️  Login test error:', error.message);
            await page.close();
            return false;
        }
    }
    
    async scrapeTweets(keyword, limit = 10) {
        if (!this.isConnected) {
            throw new Error('Not connected');
        }
        
        const startTime = Date.now();
        console.log(`🔍 Searching for: "${keyword}"`);
        
        const page = await this.context.newPage();
        
        try {
            // Use different search URLs to avoid blocks
            const searchUrls = [
                `https://twitter.com/search?q=${encodeURIComponent(keyword)}&src=typed_query`,
                `https://twitter.com/search?q=${encodeURIComponent(keyword)}&f=live`,
                `https://x.com/search?q=${encodeURIComponent(keyword)}`
            ];
            
            let success = false;
            
            for (const url of searchUrls) {
                try {
                    console.log(`🌐 Trying: ${url.split('?')[0]}...`);
                    await page.goto(url, {
                        waitUntil: 'domcontentloaded',
                        timeout: 30000
                    });
                    
                    await page.waitForTimeout(5000);
                    
                    // Check if search loaded
                    const hasResults = await page.evaluate(() => {
                        return document.querySelector('main') !== null ||
                               document.querySelector('[data-testid="primaryColumn"]') !== null ||
                               document.querySelectorAll('article').length > 0;
                    });
                    
                    if (hasResults) {
                        success = true;
                        console.log('✅ Search page loaded');
                        break;
                    }
                } catch (err) {
                    console.log(`   Failed: ${err.message}`);
                }
                
                await page.waitForTimeout(2000);
            }
            
            if (!success) {
                throw new Error('Could not load search page');
            }
            
            // Scroll to load more tweets
            console.log('📜 Loading tweets...');
            const tweets = [];
            const seenIds = new Set();
            
            for (let i = 0; i < 3; i++) {
                const newTweets = await page.evaluate((kw) => {
                    const articles = document.querySelectorAll('article');
                    const results = [];
                    
                    articles.forEach((article, idx) => {
                        try {
                            // Get tweet text
                            const textElement = article.querySelector('[data-testid="tweetText"]');
                            const text = textElement ? textElement.textContent.trim() : '';
                            
                            if (text.length < 10) return;
                            
                            // Get author
                            const authorElement = article.querySelector('[data-testid="User-Name"]');
                            const author = authorElement ? authorElement.textContent.split('·')[0].trim() : 'Unknown';
                            
                            // Get time
                            const timeElement = article.querySelector('time');
                            const timestamp = timeElement ? timeElement.getAttribute('datetime') : new Date().toISOString();
                            
                            // Get engagement
                            const getMetric = (testId) => {
                                const el = article.querySelector(`[data-testid="${testId}"]`);
                                if (!el) return 0;
                                const text = el.textContent || '';
                                const match = text.match(/(\d+)/);
                                return match ? parseInt(match[1]) : 0;
                            };
                            
                            results.push({
                                id: `tweet_${Date.now()}_${idx}`,
                                text: text.substring(0, 280),
                                author: author.substring(0, 50),
                                keyword: kw,
                                timestamp: timestamp,
                                url: `https://twitter.com/i/web/status/${Date.now()}_${idx}`,
                                metrics: {
                                    likes: getMetric('like'),
                                    retweets: getMetric('retweet'),
                                    replies: getMetric('reply')
                                },
                                scrapedAt: new Date().toISOString()
                            });
                        } catch (e) {
                            // Skip errors
                        }
                    });
                    
                    return results;
                }, keyword);
                
                // Filter unique tweets
                for (const tweet of newTweets) {
                    const key = tweet.text.substring(0, 100).toLowerCase();
                    if (!seenIds.has(key)) {
                        seenIds.add(key);
                        tweets.push(tweet);
                    }
                }
                
                console.log(`   Scroll ${i + 1}: ${newTweets.length} new, ${tweets.length} total`);
                
                if (tweets.length >= limit) break;
                
                // Scroll down
                await page.evaluate(() => {
                    window.scrollBy(0, window.innerHeight * 2);
                });
                
                await page.waitForTimeout(3000);
            }
            
            const result = tweets.slice(0, limit);
            const elapsed = Date.now() - startTime;
            
            console.log(`✅ Found ${result.length} tweets in ${elapsed}ms`);
            
            await page.close();
            return result;
            
        } catch (error) {
            console.error(`❌ Scrape failed: ${error.message}`);
            await page.close();
            throw error;
        }
    }
    
    async cleanup() {
        try {
            if (this.context) await this.context.close();
            if (this.browser) await this.browser.close();
            this.isConnected = false;
            console.log('🧹 Cleaned up');
        } catch (error) {
            console.error('Cleanup error:', error.message);
        }
    }
}

// ==================== SERVER SETUP ====================
const app = express();
app.use(express.json());

// Simple CORS
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// Create scraper instance
const scraper = new TwitterScraper();

// Routes
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Twitter Scraper - Fixed Version</title>
            <style>
                body { font-family: Arial; padding: 20px; }
                .status { padding: 10px; background: ${scraper.isConnected ? '#4CAF50' : '#f44336'}; color: white; border-radius: 5px; }
                input, button { padding: 10px; margin: 5px; }
            </style>
        </head>
        <body>
            <h1>🐦 Twitter Scraper v2.0</h1>
            <div class="status">
                Status: ${scraper.isConnected ? '✅ CONNECTED' : '❌ DISCONNECTED'}
            </div>
            <h3>Test Scraper:</h3>
            <input id="keyword" value="technology" placeholder="Keyword">
            <input id="limit" value="5" type="number">
            <button onclick="scrape()">Scrape</button>
            <div id="result" style="margin-top: 20px;"></div>
            
            <script>
                async function scrape() {
                    const keyword = document.getElementById('keyword').value;
                    const limit = document.getElementById('limit').value;
                    const resultDiv = document.getElementById('result');
                    
                    resultDiv.innerHTML = '<p>⏳ Scraping...</p>';
                    
                    try {
                        const response = await fetch('/scrape', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ keyword, limit })
                        });
                        
                        const data = await response.json();
                        
                        if (data.success) {
                            let html = '<div style="background:#4CAF50;color:white;padding:15px;border-radius:5px;">';
                            html += '<h4>✅ Success!</h4>';
                            html += '<p><strong>Keyword:</strong> ' + data.keyword + '</p>';
                            html += '<p><strong>Tweets Found:</strong> ' + data.count + '</p>';
                            html += '<p><strong>Time:</strong> ' + data.processingTime + 'ms</p>';
                            
                            if (data.tweets.length > 0) {
                                html += '<h5>Sample:</h5>';
                                data.tweets.forEach(tweet => {
                                    html += '<div style="background:white;color:black;padding:10px;margin:5px;border-radius:5px;">';
                                    html += '<p>' + tweet.text.substring(0, 100) + '...</p>';
                                    html += '<small>👤 ' + tweet.author + '</small>';
                                    html += '</div>';
                                });
                            }
                            
                            html += '</div>';
                            resultDiv.innerHTML = html;
                        } else {
                            resultDiv.innerHTML = '<div style="background:#f44336;color:white;padding:15px;border-radius:5px;">' + 
                                '<h4>❌ Error</h4><p>' + data.error + '</p></div>';
                        }
                    } catch (error) {
                        resultDiv.innerHTML = '<div style="background:#f44336;color:white;padding:15px;border-radius:5px;">' +
                            '<h4>❌ Request Failed</h4><p>' + error.message + '</p></div>';
                    }
                }
            </script>
        </body>
        </html>
    `);
});

app.get('/health', (req, res) => {
    res.json({
        status: scraper.isConnected ? 'healthy' : 'disconnected',
        timestamp: new Date().toISOString()
    });
});

app.post('/scrape', async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { keyword, limit = 5 } = req.body;
        
        if (!keyword) {
            return res.status(400).json({ 
                success: false, 
                error: 'Keyword required' 
            });
        }
        
        const tweetLimit = Math.min(parseInt(limit) || 5, 20);
        
        console.log(`📥 Request: "${keyword}" (limit: ${tweetLimit})`);
        
        const tweets = await scraper.scrapeTweets(keyword, tweetLimit);
        
        res.json({
            success: true,
            keyword: keyword,
            count: tweets.length,
            processingTime: Date.now() - startTime,
            tweets: tweets
        });
        
    } catch (error) {
        console.error('API Error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==================== START SERVER ====================
async function startServer() {
    try {
        console.log(`
╔══════════════════════════════════════════════════╗
║      TWITTER SCRAPER v2.0 - FIXED FOR VPS       ║
║        No API Keys Needed - Just Works          ║
╚══════════════════════════════════════════════════╝`);
        
        // Connect scraper
        await scraper.connect();
        
        const PORT = process.env.PORT || 3003;
        const HOST = '0.0.0.0';
        
        app.listen(PORT, HOST, () => {
            console.log(`
✅ SERVER STARTED
   URL: http://localhost:${PORT}
   Network: http://YOUR_VPS_IP:${PORT}
   
📋 TEST COMMAND:
   curl -X POST http://localhost:3003/scrape \\
        -H "Content-Type: application/json" \\
        -d '{"keyword":"bitcoin","limit":3}'
            `);
        });
        
        // Graceful shutdown
        process.on('SIGINT', async () => {
            console.log('\n🛑 Shutting down...');
            await scraper.cleanup();
            process.exit(0);
        });
        
    } catch (error) {
        console.error('❌ Startup failed:', error);
        process.exit(1);
    }
}

startServer();
