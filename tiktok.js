const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Apply stealth plugin
puppeteer.use(StealthPlugin());

const app = express();
const PORT = 3000;

// Optional proxy support
const proxyServer = ''; // Example: 'http://127.0.0.1:8080'

// Follow TikTok redirect (like shortened URLs)
function resolveRedirect(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(res.headers.location);
      } else {
        resolve(url);
      }
    }).on('error', (err) => reject(err));
  });
}

// Download video file
function downloadVideoFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(outputPath);

    protocol.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error('Download failed. Status code: ' + response.statusCode));
        return;
      }

      response.pipe(file);
      file.on('finish', () => file.close(() => resolve(outputPath)));
    }).on('error', (err) => {
      fs.unlink(outputPath, () => reject(err));
    });
  });
}

app.get('/download', async function (req, res) {
  const inputUrl = req.query.url;
  const noWatermark = req.query.nowm === 'true';

  if (!inputUrl || inputUrl.indexOf('tiktok.com') === -1) {
    return res.status(400).json({ error: 'Invalid or missing TikTok URL' });
  }

  let browser;
  try {
    const finalUrl = await resolveRedirect(inputUrl);

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-zygote',
      '--disable-gpu',
      '--window-size=375,667'
    ];
    if (proxyServer) launchArgs.push('--proxy-server=' + proxyServer);

    browser = await puppeteer.launch({
      headless: true,
      args: launchArgs,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();

    // Spoof mobile device
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1'
    );
    await page.setViewport({ width: 375, height: 667, isMobile: true });

    // Visit TikTok page
    await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });

    // Wait for video to be ready
    await page.waitForSelector('video', { timeout: 30000 });

    // Extract video source URL
    const videoSrc = await page.evaluate(function () {
      var video = document.querySelector('video');
      if (video && video.src) return video.src;

      try {
        var script = document.getElementById('__NEXT_DATA__');
        if (!script) return null;
        var json = JSON.parse(script.textContent);

        if (
          json &&
          json.props &&
          json.props.pageProps &&
          json.props.pageProps.videoData &&
          json.props.pageProps.videoData.itemInfo &&
          json.props.pageProps.videoData.itemInfo.itemStruct &&
          json.props.pageProps.videoData.itemInfo.itemStruct.video
        ) {
          if (json.props.pageProps.videoData.itemInfo.itemStruct.video.playAddr) {
            return json.props.pageProps.videoData.itemInfo.itemStruct.video.playAddr;
          }
        }
      } catch (e) {
        return null;
      }

      return null;
    });

    if (!videoSrc || videoSrc.indexOf('http') === -1) {
      throw new Error('Could not retrieve video source');
    }

    const fileName = 'tiktok_' + Date.now() + (noWatermark ? '_nowm' : '_wm') + '.mp4';
    const outputPath = path.join(__dirname, fileName);

    await downloadVideoFile(videoSrc, outputPath);
    await browser.close();

    return res.json({
      message: '✅ Downloaded successfully!',
      path: outputPath,
      note: noWatermark ? 'Tried downloading without watermark' : 'Watermarked version',
    });

  } catch (err) {
    if (browser) await browser.close();
    console.error('❌ Error:', err.message);
    return res.status(500).json({
      error: 'Failed to download TikTok video',
      details: err.message,
    });
  }
});

app.listen(PORT, function () {
  console.log('🚀 Server is running at: http://localhost:' + PORT);
});
