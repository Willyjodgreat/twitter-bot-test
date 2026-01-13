// twitter_graphql_scraper.js - UPDATED FOR 2026 X.COM
const { chromium } = require('playwright');
const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
require('dotenv').config();

class TwitterGraphQLScraper {
    constructor() {
        this.browser = null;
        this.context = null;
        this.isConnected = false;
        this.sessionFile = 'twitter_session.json';
        this.port = process.env.PORT || 3003;
        this.apiKey = process.env.API_KEY || 'Willyjodgreat';
    }
    
    async connect() {
        try {
            console.log('🚀 Starting GraphQL scraper...');
            
            // Browser setup
            const browserArgs = [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--window-size=1280,720',
                '--disable-blink-features=AutomationControlled'
            ];
            
            this.browser = await chromium.launch({ 
                headless: true,
                args: browserArgs
            });
            
            this.context = await this.browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ignoreHTTPSErrors: true
            });
            
            // Load cookies
            if (fs.existsSync(this.sessionFile)) {
                try {
                    const session = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
                    await this.context.addCookies(session.cookies || []);
                    console.log(`✅ Loaded ${(session.cookies || []).length} cookies`);
                } catch (e) {
                    console.log('⚠️ Cookie error:', e.message);
                }
            }
            
            // Quick test
            const page = await this.context.newPage();
            await page.goto('https://x.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(2000);
            await page.close();
            
            this.isConnected = true;
            console.log('✅ Connected!');
            return true;
            
        } catch (error) {
            console.error('❌ Connection failed:', error.message);
            if (this.browser) await this.browser.close();
            throw error;
        }
    }
    
    async scrapeTweets(keyword, limit = 10) {
        if (!this.isConnected) throw new Error('Not connected');
        
        console.log(`🔍 Searching: "${keyword}" (limit: ${limit})`);
        
        const page = await this.context.newPage();
        const tweets = [];
        
        try {
            // Listen for GraphQL responses
            page.on('response', async (response) => {
                try {
                    const url = response.url();
                    if (url.includes('/graphql/') && (url.includes('SearchTimeline') || url.includes('Search'))) {
                        const data = await response.json();
                        
                        // Extract tweets from GraphQL response
                        const extracted = this.extractTweetsFromGraphQL(data, keyword);
                        extracted.forEach(tweet => {
                            if (!tweets.some(t => t.id === tweet.id) && tweets.length < limit) {
                                tweets.push(tweet);
                            }
                        });
                        
                        console.log(`📥 GraphQL: Found ${extracted.length} tweets, total: ${tweets.length}`);
                    }
                } catch (e) {
                    // Silent fail for non-JSON responses
                }
            });
            
            // Go to search page
            const searchUrl = `https://x.com/search?q=${encodeURIComponent(keyword)}&src=typed_query`;
            console.log(`🌐 Loading: ${searchUrl}`);
            
            await page.goto(searchUrl, {
                waitUntil: 'networkidle',
                timeout: 30000
            });
            
            // Wait for GraphQL calls
            await page.waitForTimeout(5000);
            
            // Scroll to trigger more API calls
            for (let i = 0; i < 3 && tweets.length < limit; i++) {
                await page.evaluate(() => window.scrollBy(0, 1000));
                await page.waitForTimeout(3000);
                
                if (tweets.length >= limit) break;
            }
            
            await page.close();
            
            console.log(`✅ Total tweets found: ${tweets.length}`);
            return tweets.slice(0, limit);
            
        } catch (error) {
            await page.close();
            console.error(`❌ Scrape failed: ${error.message}`);
            
            // Fallback to HTML scraping if GraphQL fails
            console.log('🔄 Trying HTML fallback...');
            return this.fallbackHTMLScrape(keyword, limit);
        }
    }
    
    extractTweetsFromGraphQL(data, keyword) {
        const tweets = [];
        
        try {
            // Try different GraphQL response structures
            const paths = [
                data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions,
                data?.data?.search?.search_timeline?.timeline_response?.instructions,
                data?.data?.searchTimeline?.timeline?.instructions,
                data?.data?.searchTimeline?.instructions
            ];
            
            for (const instructions of paths) {
                if (instructions && Array.isArray(instructions)) {
                    instructions.forEach(instruction => {
                        if (instruction.type === 'TimelineAddEntries') {
                            instruction.entries?.forEach(entry => {
                                if (entry.content?.itemContent?.tweet_results?.result) {
                                    const tweetData = entry.content.itemContent.tweet_results.result;
                                    this.processTweetData(tweetData, tweets, keyword);
                                }
                                
                                // Check for timeline modules
                                if (entry.content?.items) {
                                    entry.content.items.forEach(item => {
                                        if (item.item?.itemContent?.tweet_results?.result) {
                                            const tweetData = item.item.itemContent.tweet_results.result;
                                            this.processTweetData(tweetData, tweets, keyword);
                                        }
                                    });
                                }
                            });
                        }
                    });
                }
            }
        } catch (e) {
            console.log('⚠️ GraphQL parsing error:', e.message);
        }
        
        return tweets;
    }
    
    processTweetData(tweetData, tweets, keyword) {
        try {
            const legacy = tweetData.legacy || tweetData.core?.user_results?.result?.legacy || tweetData;
            
            if (!legacy?.full_text) return;
            
            const author = tweetData.core?.user_results?.result?.legacy?.screen_name || 
                          tweetData.core?.user_results?.result?.legacy?.name || 
                          'Unknown';
            
            tweets.push({
                id: tweetData.rest_id || `tweet_${Date.now()}`,
                text: legacy.full_text,
                author: author,
                keyword: keyword,
                length: legacy.full_text.length,
                scrapedAt: new Date().toISOString(),
                likes: legacy.favorite_count || 0,
                retweets: legacy.retweet_count || 0,
                replies: legacy.reply_count || 0
            });
        } catch (e) {
            // Skip bad data
        }
    }
    
    async fallbackHTMLScrape(keyword, limit) {
        const page = await this.context.newPage();
        const allTweets = [];
        
        try {
            await page.goto(`https://mobile.twitter.com/search?q=${encodeURIComponent(keyword)}`, {
                waitUntil: 'networkidle',
                timeout: 20000
            });
            
            await page.waitForTimeout(3000);
            
            // Simple HTML scraping as fallback
            for (let i = 0; i < 3 && allTweets.length < limit; i++) {
                const tweets = await page.evaluate((kw) => {
                    const elements = document.querySelectorAll('article, [data-testid="tweet"], [role="article"]');
                    const results = [];
                    
                    elements.forEach((el, idx) => {
                        const text = el.innerText || '';
                        if (text.length > 50) {
                            results.push({
                                id: `html_${Date.now()}_${idx}`,
                                text: text.substring(0, 300),
                                author: text.split('\n')[0] || 'Unknown',
                                keyword: kw,
                                length: text.length,
                                scrapedAt: new Date().toISOString()
                            });
                        }
                    });
                    
                    return results;
                }, keyword);
                
                tweets.forEach(tweet => {
                    if (!allTweets.some(t => t.text.substring(0, 50) === tweet.text.substring(0, 50))) {
                        allTweets.push(tweet);
                    }
                });
                
                if (allTweets.length < limit) {
                    await page.evaluate(() => window.scrollBy(0, 1000));
                    await page.waitForTimeout(2000);
                }
            }
            
            await page.close();
            console.log(`🔄 HTML fallback found: ${allTweets.length} tweets`);
            return allTweets.slice(0, limit);
            
        } catch (error) {
            await page.close();
            console.error('HTML fallback failed:', error.message);
            return [];
        }
    }
    
    async cleanup() {
        try {
            if (this.context) await this.context.close();
            if (this.browser) await this.browser.close();
            this.isConnected = false;
        } catch (e) {
            // Ignore
        }
    }
}

// Express server - SIMPLE VERSION
const app = express();
app.use(express.json());

// API key check
app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/health') return next();
    
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (!key || key !== (process.env.API_KEY || 'Willyjodgreat')) {
        return res.status(401).json({ error: 'Bad API key' });
    }
    
    next();
});

const scraper = new TwitterGraphQLScraper();

// Routes
app.get('/', (req, res) => {
    res.send(`
        <html>
        <head><title>X Scraper</title><style>
            body{font-family:sans-serif;padding:20px;background:#15202b;color:white}
            .card{background:#1e2732;padding:20px;border-radius:10px;margin:20px 0}
            input,button{padding:10px;margin:5px;border-radius:5px;border:none}
            button{background:#1da1f2;color:white;cursor:pointer}
        </style></head>
        <body>
            <h1>🐦 X GraphQL Scraper</h1>
            <div class="card">
                <h3>🔍 Scrape Tweets</h3>
                <input id="keyword" placeholder="Keyword" value="technology">
                <input id="limit" type="number" value="5" min="1" max="20">
                <button onclick="scrape()">Scrape</button>
                <div id="result" style="margin-top:15px"></div>
            </div>
            <script>
                async function scrape() {
                    const kw = document.getElementById('keyword').value;
                    const limit = document.getElementById('limit').value;
                    const result = document.getElementById('result');
                    result.innerHTML = '⏳ Scraping...';
                    
                    try {
                        const res = await fetch('/scrape', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'x-api-key': '${scraper.apiKey}' },
                            body: JSON.stringify({ keyword: kw, limit: parseInt(limit) })
                        });
                        const data = await res.json();
                        
                        if (data.success) {
                            let html = '<h4>✅ ' + data.count + ' tweets found</h4>';
                            data.tweets.forEach(t => {
                                html += '<div style="background:#273340;padding:10px;margin:5px;border-radius:5px">';
                                html += '<p>' + t.text.substring(0,150) + '...</p>';
                                html += '<small>👤 ' + t.author + ' | 📏 ' + t.length + ' chars</small>';
                                html += '</div>';
                            });
                            result.innerHTML = html;
                        } else {
                            result.innerHTML = '❌ Error: ' + data.error;
                        }
                    } catch(e) {
                        result.innerHTML = '❌ Request failed: ' + e.message;
                    }
                }
            </script>
        </body>
        </html>
    `);
});

app.get('/health', (req, res) => {
    res.json({
        status: scraper.isConnected ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString(),
        port: scraper.port
    });
});

app.post('/scrape', async (req, res) => {
    try {
        const { keyword, limit = 5 } = req.body;
        if (!keyword) return res.status(400).json({ error: 'Keyword required' });
        
        const tweets = await scraper.scrapeTweets(keyword.trim(), Math.min(limit, 20));
        
        res.json({
            success: true,
            keyword: keyword,
            count: tweets.length,
            tweets: tweets
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Start server
async function start() {
    try {
        await scraper.connect();
        
        const server = http.createServer(app);
        server.listen(scraper.port, '0.0.0.0', () => {
            console.log(`
✅ SERVER READY
Port: ${scraper.port}
Local: http://localhost:${scraper.port}
API Key: ${scraper.apiKey}

Test with:
curl -X POST http://localhost:${scraper.port}/scrape \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: ${scraper.apiKey}" \\
  -d '{"keyword":"test","limit":3}'
            `);
        });
        
        // Clean shutdown
        process.on('SIGINT', async () => {
            console.log('\nShutting down...');
            await scraper.cleanup();
            process.exit(0);
        });
        
    } catch (error) {
        console.error('Startup failed:', error);
        process.exit(1);
    }
}

start();
