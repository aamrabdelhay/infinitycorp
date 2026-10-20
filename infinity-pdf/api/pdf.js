import dns from "node:dns/promises";
import net from "node:net";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const MAX_RENDER_MS = 45_000;
const MAX_PDF_BYTES = 18 * 1024 * 1024;
const MAX_SINGLE_WIDTH = 7_000;
const MAX_SINGLE_HEIGHT = 18_000;
const ALLOWED_VIEWPORTS = new Set([1024, 1280, 1440]);
const PAPER_SIZES = new Set(["A4", "A3", "Letter", "Legal"]);
const requestBuckets = new Map();

function errorResponse(res, status, message) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.end(JSON.stringify({ error: message }));
}

function isBlockedIPv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const value = parts.reduce((acc, octet) => acc * 256 + octet, 0);
  const ranges = [
    [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
    [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
    [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24],
    [0xe0000000, 4], [0xf0000000, 4]
  ];
  return ranges.some(([base, bits]) => Math.floor(value / (2 ** (32 - bits))) === Math.floor(base / (2 ** (32 - bits))));
}

function isPublicIp(address) {
  const family = net.isIP(address);
  if (family === 4) return !isBlockedIPv4(address);
  if (family !== 6) return false;
  const ip = address.toLowerCase().split("%")[0];
  if (ip === "::" || ip === "::1") return false;
  if (ip.startsWith("::ffff:")) {
    const tail = ip.slice(7);
    if (net.isIP(tail) === 4) return isPublicIp(tail);
    const groups = tail.split(":");
    if (groups.length === 2 && groups.every(part => /^[a-f0-9]{1,4}$/.test(part))) {
      const firstGroup = parseInt(groups[0], 16);
      const secondGroup = parseInt(groups[1], 16);
      const v4 = (firstGroup >> 8) + "." + (firstGroup & 255) + "." + (secondGroup >> 8) + "." + (secondGroup & 255);
      return isPublicIp(v4);
    }
    return false;
  }
  const first = parseInt(ip.split(":")[0] || "0", 16);
  // Only global-unicast 2000::/3 is accepted; documentation and transition ranges are denied too.
  if (first < 0x2000 || first > 0x3fff) return false;
  if (ip.startsWith("2001:db8:") || ip === "2001:db8::" || ip.startsWith("2001:0:") || ip.startsWith("2001:10:") || ip.startsWith("2001:2:") || ip.startsWith("2002:")) return false;
  return true;
}

function parseHttpUrl(input) {
  let target;
  try { target = new URL(input); } catch { throw new Error("الرابط غير صالح. أدخل رابطًا عامًا يبدأ بـ https:// أو http://."); }
  if (!["http:", "https:"].includes(target.protocol)) throw new Error("يُسمح بروابط HTTP وHTTPS فقط.");
  if (target.username || target.password) throw new Error("الروابط التي تحتوي على بيانات دخول غير مسموح بها.");
  if (!target.hostname) throw new Error("الرابط لا يحتوي على اسم موقع صالح.");
  target.hash = "";
  return target;
}

async function publicHttpTarget(input, cache) {
  const target = parseHttpUrl(input);
  const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (["localhost", "localhost.", "metadata.google.internal"].includes(host) || /\.(local|localhost|internal|home|home\.arpa|test|invalid|example)$/.test(host)) {
    throw new Error("لا يمكن تحويل روابط الشبكات الداخلية أو المحلية.");
  }

  const literalFamily = net.isIP(host);
  if (literalFamily) {
    if (!isPublicIp(host)) throw new Error("عناوين IP الخاصة أو المحجوزة غير مسموح بها.");
    return target;
  }

  let addresses = cache.get(host);
  if (!addresses) {
    try { addresses = await dns.lookup(host, { all: true, verbatim: true }); }
    catch { throw new Error("تعذّر العثور على عنوان عام لهذا الموقع."); }
    if (!addresses.length || addresses.some(item => !isPublicIp(item.address))) {
      throw new Error("هذا الموقع يحلّ إلى عنوان IP داخلي أو غير عام، لذلك تم رفض الطلب.");
    }
    cache.set(host, addresses);
  }
  return target;
}

function allowedByRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const existing = requestBuckets.get(ip);
  if (!existing || now - existing.startedAt > windowMs) {
    requestBuckets.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  if (existing.count >= 8) return false;
  existing.count += 1;
  return true;
}

function getOptions(body) {
  const mode = body?.mode === "paged" ? "paged" : "single";
  const paperSize = PAPER_SIZES.has(body?.paperSize) ? body.paperSize : "A4";
  const viewportWidth = ALLOWED_VIEWPORTS.has(Number(body?.viewportWidth)) ? Number(body.viewportWidth) : 1280;
  const margins = body?.margins === "none" ? "none" : body?.margins === "default" ? "default" : "small";
  const marginMap = { none: "0mm", small: "5mm", default: "10mm" };
  return {
    mode, paperSize, landscape: body?.orientation === "landscape", viewportWidth,
    margins: marginMap[margins], cleanMode: body?.cleanMode === true,
    printBackground: body?.printBackground !== false, headers: body?.headers === true,
    printCss: body?.printCss === true
  };
}

function cleanFilename(title, host) {
  const source = (title || host || "webpage").normalize("NFKC").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
  return (source || "webpage") + ".pdf";
}

async function preparePage(page, options) {
  await page.emulateMediaType(options.printCss ? "print" : "screen");
  await page.evaluate(async () => {
    const style = document.createElement("style");
    style.id = "infinity-pdf-print-preparation";
    style.textContent = "html{scroll-behavior:auto!important}*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}img{print-color-adjust:exact;-webkit-print-color-adjust:exact}";
    (document.head || document.documentElement).appendChild(style);

    const cap = 45_000;
    const step = Math.max(500, window.innerHeight || 800);
    const total = Math.min(Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0), cap);
    for (let y = 0; y < total; y += step) {
      window.scrollTo(0, y);
      await new Promise(resolve => setTimeout(resolve, 45));
    }
    window.scrollTo(0, 0);
    await Promise.race([
      document.fonts?.ready || Promise.resolve(),
      new Promise(resolve => setTimeout(resolve, 2500))
    ]);
    await Promise.race([
      Promise.all(Array.from(document.images || []).map(img => {
        if (img.complete) return Promise.resolve();
        return new Promise(resolve => {
          img.addEventListener("load", resolve, { once: true });
          img.addEventListener("error", resolve, { once: true });
          setTimeout(resolve, 1500);
        });
      })),
      new Promise(resolve => setTimeout(resolve, 4500))
    ]);
  });

  if (options.cleanMode) {
    await page.addStyleTag({ content: [
      '[class*="cookie" i],[id*="cookie" i],[class*="advert" i],[id*="advert" i],',
      '[class*="ad-slot" i],[id*="ad-slot" i],[class*="sidebar" i],[id*="sidebar" i],',
      '[role="dialog"],[aria-modal="true"],.modal-backdrop,.newsletter-popup{display:none!important;visibility:hidden!important;opacity:0!important;pointer-events:none!important}',
      '[style*="position: fixed" i],[style*="position:fixed" i],[style*="position: sticky" i],[style*="position:sticky" i]{position:absolute!important;top:auto!important;bottom:auto!important}'
    ].join("\n") });
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return errorResponse(res, 405, "استخدم طلب POST لإنشاء ملف PDF.");
  }

  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim().slice(0, 100);
  if (!allowedByRateLimit(ip)) return errorResponse(res, 429, "تم تجاوز عدد الطلبات المسموح به مؤقتًا. انتظر دقيقة ثم حاول مرة أخرى.");

  const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return null; } })() : req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return errorResponse(res, 400, "بيانات الطلب غير صالحة.");
  if (typeof body.url !== "string" || body.url.length > 2048) return errorResponse(res, 400, "أدخل رابطًا صالحًا لا يتجاوز 2048 حرفًا.");

  const options = getOptions(body);
  const cache = new Map();
  let browser;
  let renderTimer;
  const renderWork = async () => {
    await publicHttpTarget(body.url, cache);
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
      defaultViewport: { width: options.viewportWidth, height: 900, deviceScaleFactor: 1 },
      timeout: 20_000
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(25_000);
    page.setDefaultTimeout(10_000);
    page.setRequestInterception(true);
    let checkedRequests = 0;
    const MAX_PAGE_REQUESTS = 180;

    page.on("request", request => {
      (async () => {
        const requestUrl = request.url();
        const protocol = (() => { try { return new URL(requestUrl).protocol; } catch { return ""; } })();
        if (["data:", "blob:", "about:"].includes(protocol)) return request.continue();
        if (!["http:", "https:"].includes(protocol)) return request.abort("blockedbyclient");
        checkedRequests += 1;
        if (checkedRequests > MAX_PAGE_REQUESTS) return request.abort("blockedbyclient");
        try {
          await publicHttpTarget(requestUrl, cache);
          return request.continue();
        } catch {
          return request.abort("blockedbyclient");
        }
      })().catch(() => { try { if (request.isInterceptResolutionHandled?.()) return; request.abort("blockedbyclient"); } catch { /* request already resolved */ } });
    });

    let response;
    try {
      response = await page.goto(body.url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    } catch (error) {
      if (/timeout/i.test(error?.message || "")) throw new Error("انتهت مهلة فتح الصفحة. جرّب صفحة أخف أو موقعًا آخر.");
      throw new Error("تعذّر فتح الصفحة. قد يمنع الموقع الفتح الآلي أو يكون غير متاح.");
    }
    if (response && response.status() >= 400) throw new Error("الموقع أعاد استجابة HTTP " + response.status() + " ولم يسمح بإنشاء الملف.");

    await Promise.race([
      page.waitForNetworkIdle({ idleTime: 500, timeout: 6000 }),
      new Promise(resolve => setTimeout(resolve, 6000))
    ]);
    await preparePage(page, options);

    const dimensions = await page.evaluate(() => ({
      width: Math.max(document.documentElement?.scrollWidth || 0, document.body?.scrollWidth || 0, window.innerWidth || 0),
      height: Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0, window.innerHeight || 0),
      title: document.title || "",
      host: location.hostname
    }));
    if (!dimensions.width || !dimensions.height) throw new Error("الصفحة لا تحتوي على محتوى يمكن تحويله.");

    let pdfOptions;
    if (options.mode === "single") {
      if (dimensions.width > MAX_SINGLE_WIDTH || dimensions.height > MAX_SINGLE_HEIGHT) {
        throw new Error("الصفحة أطول أو أعرض من حد الصفحة الواحدة في Chromium. اختر «صفحات ورقية عادية» للحصول على ملف كامل.");
      }
      pdfOptions = {
        width: Math.ceil(dimensions.width) + "px",
        height: Math.ceil(dimensions.height) + "px",
        margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
        printBackground: options.printBackground,
        preferCSSPageSize: false,
        displayHeaderFooter: false
      };
    } else {
      pdfOptions = {
        format: options.paperSize,
        landscape: options.landscape,
        margin: { top: options.margins, right: options.margins, bottom: options.margins, left: options.margins },
        printBackground: options.printBackground,
        preferCSSPageSize: false,
        displayHeaderFooter: options.headers,
        headerTemplate: '<div style="font-size:8px;width:100%;margin:0 10mm;color:#777;text-align:center"><span class="title"></span></div>',
        footerTemplate: '<div style="font-size:8px;width:100%;margin:0 10mm;color:#777;display:flex;justify-content:space-between"><span class="url"></span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>'
      };
    }

    const pdf = await page.pdf(pdfOptions);
    if (!pdf || !pdf.length) throw new Error("لم ينتج المتصفح ملف PDF.");
    if (pdf.length > MAX_PDF_BYTES) throw new Error("حجم الملف أكبر من الحد المسموح (18 ميجابايت). جرّب تقليل عرض الصفحة أو استخدام رابط أخف.");
    return { pdf: Buffer.from(pdf), filename: cleanFilename(dimensions.title, dimensions.host) };
  };

  try {
    const timedWork = new Promise((_, reject) => {
      renderTimer = setTimeout(() => {
        if (browser) browser.close().catch(() => {});
        reject(new Error("استغرقت الصفحة وقتًا أطول من المسموح. جرّب صفحة أصغر أو أعد المحاولة."));
      }, MAX_RENDER_MS);
    });
    const result = await Promise.race([renderWork(), timedWork]);
    const encodedName = encodeURIComponent(result.filename);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", String(result.pdf.length));
    res.setHeader("Content-Disposition", 'attachment; filename="webpage.pdf"; filename*=UTF-8\'\'' + encodedName);
    res.end(result.pdf);
  } catch (error) {
    const message = typeof error?.message === "string" ? error.message : "حدث خطأ أثناء إنشاء PDF.";
    const status = /رابط|عنوان IP|داخلية|غير صالح|بيانات دخول|روابط HTTP/i.test(message) ? 400 : /تجاوز عدد الطلبات/.test(message) ? 429 : 502;
    return errorResponse(res, status, message);
  } finally {
    clearTimeout(renderTimer);
    if (browser) {
      try { await browser.close(); } catch { /* best-effort browser cleanup */ }
    }
  }
}