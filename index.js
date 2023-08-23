const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const bodyParser = require('body-parser');
const url = require("url");
const fs = require('fs').promises;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const app = express();
app.use(express.static(__dirname));
app.use(bodyParser.urlencoded({ extended: true }));

app.locals.session_id = 1;
app.locals.status = {}
app.locals.error_message = {}
app.locals.meter = {}
app.locals.total = {}

const getBrowser = () =>
    IS_PRODUCTION
        ?
        puppeteer.connect({ browserWSEndpoint: 'wss://chrome.browserless.io?token=API_TOKEN' })
        :
        puppeteer.launch({headless: false});

app.get('/', async (req, res) => {
    res.sendFile(path.join(__dirname+'/main.html'));
})

app.get('/waiting', async (req, res) => {
    const content = await fs.readFile(path.join(__dirname+'/wait.html'), "utf-8");
    const session_id = req.query.session_id;
    res.send(content.replace('{session_id}', session_id));
})

app.get('/status', async (req, res) => {
    const session_id = req.query.session_id;
    if(req.app.locals.status[session_id] === 'error')
    {
        res.send({
            "status": req.app.locals.status[session_id],
            "message": req.app.locals.error_message[session_id]})
    } else
    {
        res.send({
            "status": req.app.locals.status[session_id],
            "meter":  req.app.locals.meter[session_id],
            "total": req.app.locals.total[session_id]})
    }
})

app.post('/process', async (req, res) => {
    let browser = null;

    const episodeFrom = req.body.episode_old;
    const episodeTo = req.body.episode_new;
    const domainFrom = url.parse(req.body.episode_old).hostname;
    const domainTo = url.parse(req.body.episode_new).hostname;
    const session_id = req.app.locals.session_id;
    req.app.locals.status[session_id] = 'starting';
    req.app.locals.meter[session_id] = 0;
    req.app.locals.total[session_id] = 0;

    let globalPosts = [];
    let globalPostNumber = 0;

    const users = req.body.user;

    res.status(200)
    res.redirect('/waiting?session_id='+session_id)
    req.app.locals.session_id += 1;

    req.app.locals.status[session_id] = 'copying';

    for (const item of users) {
        try {
            browser = await getBrowser();
            const page = await browser.newPage();

            // login
            item.idOld = await login(page, domainFrom, item.nameOld, item.passOld, session_id);
            if(req.app.locals.status[session_id] === 'error') {
                return;
            }

            //scrape episode
            await page.goto(episodeFrom);
            const posts = await page.$$('#pun-main .post');
            posts.shift();
            globalPostNumber = posts.length;
            req.app.locals.total[session_id] = globalPostNumber;
            const hrefs = [];
            for (const post of posts) {
                const nelem = await post.$('a.sharelink+strong');
                const n = await page.evaluate(el => el.innerText, nelem);
                const postUserId = await page.evaluate(el => el.getAttribute("data-user-id"), post);

                if(postUserId  === item.idOld) {
                    const link = await post.$('.pl-edit a');
                    const href = await page.evaluate(el => el.getAttribute("href"), link);
                    hrefs.push({href: href, n: n});
                }
            }

            for(const elem of hrefs) {
                await page.goto(elem.href);
                await page.waitForSelector('#main-reply');
                const area = await page.$('#main-reply');
                const text = await page.evaluate(el => el.textContent, area);
                globalPosts[elem.n] = {
                    idOld: item.idOld,
                    text: text
                }
                req.app.locals.meter[session_id] += 1;
            }

        } catch (error) {
            if (!res.headersSent) {
                req.app.locals.status[session_id] = 'error';
                req.app.locals.error_message[session_id] = 'unknown error while copying';
            }
        } finally {
            if (browser) {
                browser.close();
            }
        }
    }

    req.app.locals.status[session_id] = 'copied';

    if (Object.keys(globalPosts).length !== globalPostNumber) {
        req.app.locals.status[session_id] = 'error';
        req.app.locals.error_message[session_id] = 'Not all posts were copied';
        return;
    }

    req.app.locals.status[session_id] = 'preparing_past';
    req.app.locals.meter[session_id] = 0;
    const browsers = {}
    const pages = {}
    try {
        for (const user of users) {
            const browser = await getBrowser();
            const page = await browser.newPage();
            await login(page, domainTo, user.nameNew, user.passNew, session_id);
            await page.goto(episodeTo);
            await page.waitForSelector('#main-reply');
            browsers[user.idOld] = browser
            pages[user.idOld] = page
        }

        req.app.locals.status[session_id] = 'pasting';

        for (let n = 1; n <= globalPostNumber; n++) {
            const post = globalPosts[n+1];
            await pages[post.idOld].waitForSelector('#main-reply');
            const area = await pages[post.idOld].$('#main-reply');
            await pages[post.idOld].evaluate((el, post) => el.value = post.text, area, post);
            const buttons = await pages[post.idOld].$$('form#post .formsubmit input.submit')
            pages[post.idOld].on('dialog', async dialog => {
                req.app.locals.status[session_id] = 'error';
                req.app.locals.error_message[session_id] = dialog.message();
            });
            await buttons[0].click();
            await pages[post.idOld].waitForSelector('#main-reply');
            req.app.locals.meter[session_id] += 1;
            await new Promise(r => setTimeout(r, 2000));
        }

    } catch (error) {
        if (!res.headersSent) {
            req.app.locals.status[session_id] = 'error';
            req.app.locals.error_message[session_id] = error.message;
        }
    } finally {
        Object.keys(browsers).forEach((key) => {
            browsers[key].close();
        })
    }
    if(req.app.locals.status[session_id] !== 'error')
    {
        req.app.locals.status[session_id] = 'finish';
    }
});

async function login(page, domain, name, pass, session_id)
{
    await page.goto('https://'+domain+'/login.php', {waitUntil: 'networkidle0'});
    await page.waitForSelector('#fld1');
    await page.type('#pun-main #fld1', name);
    await page.type('#pun-main #fld2', pass);
    const buttons = await page.$$('#pun-main .formsubmit input.button')
    await buttons[0].click();
    await page.waitForSelector('#pun-status');
    const id = await page.evaluate(() => window['UserID'].toString());
    if(id === '1') {
        app.locals.status[session_id] = 'error';
        app.locals.error_message[session_id] = 'Login failed for user ' + name;
    }
    return id
}

app.listen(8080, () => console.log('Listening on PORT: 8080'));
