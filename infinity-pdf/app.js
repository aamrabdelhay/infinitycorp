(() => {
  "use strict";

  const form = document.getElementById("export-form");
  const urlInput = document.getElementById("page-url");
  const batchToggle = document.getElementById("batch-toggle");
  const batchPanel = document.getElementById("batch-panel");
  const batchInput = document.getElementById("batch-urls");
  const exportButton = document.getElementById("export-button");
  const buttonLabel = exportButton.querySelector(".button-label");
  const progressWrap = document.getElementById("progress-wrap");
  const progressMessage = document.getElementById("progress-message");
  const progressCount = document.getElementById("progress-count");
  const progressBar = document.getElementById("progress-bar");
  const statusMessage = document.getElementById("status-message");
  const paperSizeWrap = document.getElementById("paper-size-wrap");
  const orientationWrap = document.getElementById("orientation-wrap");
  const modeCards = [...document.querySelectorAll(".mode-card")];

  const setStatus = (message, type = "success") => {
    statusMessage.textContent = message;
    statusMessage.classList.toggle("error", type === "error");
    statusMessage.hidden = !message;
  };

  const selectedMode = () => document.querySelector('input[name="mode"]:checked')?.value || "single";

  const updateModeUI = () => {
    const paged = selectedMode() === "paged";
    paperSizeWrap.hidden = !paged;
    orientationWrap.hidden = !paged;
    modeCards.forEach(card => {
      const input = card.querySelector("input");
      card.classList.toggle("selected", Boolean(input?.checked));
    });
    document.getElementById("page-headers").disabled = !paged;
  };

  document.querySelectorAll('input[name="mode"]').forEach(input => input.addEventListener("change", updateModeUI));
  updateModeUI();

  batchToggle.addEventListener("click", () => {
    const expanded = batchToggle.getAttribute("aria-expanded") === "true";
    batchToggle.setAttribute("aria-expanded", String(!expanded));
    batchPanel.hidden = expanded;
    batchToggle.querySelector(".batch-toggle-icon").textContent = expanded ? "＋" : "−";
  });

  document.getElementById("paste-example").addEventListener("click", () => {
    urlInput.value = "https://example.com/";
    urlInput.focus();
  });

  const normalizeUrl = (value) => {
    const raw = value.trim();
    if (!raw) throw new Error("أدخل رابط الصفحة أولًا.");
    let parsed;
    try { parsed = new URL(raw); } catch { throw new Error("الرابط غير مكتوب بشكل صحيح. استخدم رابطًا يبدأ بـ https:// أو http://."); }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("يُسمح بروابط HTTP وHTTPS فقط.");
    if (parsed.username || parsed.password) throw new Error("لا تستخدم رابطًا يحتوي على اسم مستخدم أو كلمة مرور.");
    return parsed.href;
  };

  const getRequestOptions = (url) => ({
    url,
    mode: selectedMode(),
    paperSize: document.getElementById("paper-size").value,
    orientation: document.getElementById("orientation").value,
    viewportWidth: Number(document.getElementById("viewport-width").value),
    margins: document.getElementById("margins").value,
    cleanMode: document.getElementById("clean-mode").checked,
    printBackground: document.getElementById("print-backgrounds").checked,
    headers: document.getElementById("page-headers").checked,
    printCss: document.getElementById("print-css").checked
  });

  const getFilename = (response, fallbackUrl) => {
    const header = response.headers.get("content-disposition") || "";
    const encoded = header.match(/filename\*=UTF-8''([^;]+)/i);
    if (encoded) {
      try { return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, "")); } catch { /* use fallback */ }
    }
    const basic = header.match(/filename="?([^";]+)"?/i);
    if (basic) return basic[1];
    try { return new URL(fallbackUrl).hostname.replace(/[^a-z0-9.-]/gi, "_") + ".pdf"; } catch { return "webpage.pdf"; }
  };

  const downloadBlob = (blob, filename) => {
    const blobUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
  };

  const convertOne = async (url) => {
    const response = await fetch("./api/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/pdf, application/json" },
      body: JSON.stringify(getRequestOptions(url)),
      cache: "no-store"
    });

    if (!response.ok) {
      let message = "تعذّر تحويل هذه الصفحة. جرّب رابطًا عامًا آخر.";
      try {
        const data = await response.json();
        if (typeof data.error === "string") message = data.error;
      } catch { /* the server may return a gateway error page */ }
      throw new Error(message);
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/pdf")) throw new Error("استجابة الخادم لم تكن ملف PDF صالحًا.");
    const blob = await response.blob();
    if (!blob.size) throw new Error("الملف الناتج فارغ. جرّب تغيير طريقة التقسيم.");
    return { blob, filename: getFilename(response, url) };
  };

  const setProgress = (current, total, message) => {
    progressWrap.hidden = false;
    progressMessage.textContent = message;
    progressCount.textContent = total > 1 ? current + " / " + total : "";
    progressBar.style.width = Math.max(4, Math.round((current / total) * 100)) + "%";
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("");

    let urls;
    try {
      const batchText = batchPanel.hidden ? "" : batchInput.value.trim();
      urls = batchText
        ? [...new Set(batchText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(normalizeUrl))]
        : [normalizeUrl(urlInput.value)];
      if (urls.length > 5) throw new Error("الحد الأقصى في الدفعة الواحدة هو 5 روابط.");
      if (!urls.length) throw new Error("أدخل رابطًا واحدًا على الأقل.");
    } catch (error) {
      setStatus(error.message || "تحقق من الروابط المدخلة.", "error");
      return;
    }

    exportButton.disabled = true;
    buttonLabel.textContent = "جارٍ التحويل…";
    setProgress(0, urls.length, "جارٍ فتح الصفحة وتجهيز محتواها…");
    let completed = 0;
    const errors = [];

    try {
      for (const [index, url] of urls.entries()) {
        setProgress(index, urls.length, urls.length > 1 ? "جارٍ معالجة الرابط " + (index + 1) + " من " + urls.length + "…" : "جارٍ فتح الصفحة وتجهيز محتواها…");
        try {
          const { blob, filename } = await convertOne(url);
          downloadBlob(blob, filename);
          completed += 1;
          setProgress(index + 1, urls.length, "اكتمل تحويل الرابط " + (index + 1) + ".");
          if (urls.length > 1) await new Promise(resolve => window.setTimeout(resolve, 500));
        } catch (error) {
          errors.push(new URL(url).hostname + ": " + (error.message || "تعذّر التحويل"));
        }
      }

      if (completed && !errors.length) setStatus(urls.length > 1 ? "اكتمل تحويل " + completed + " ملفات PDF. راجع التنزيلات في المتصفح." : "اكتمل إنشاء ملف PDF وبدأ تنزيله.");
      else if (completed && errors.length) setStatus("تم تنزيل " + completed + " ملف/ملفات، لكن تعذّر تحويل: " + errors.join(" — "), "error");
      else setStatus(errors.join(" — ") || "لم يكتمل التحويل. حاول مرة أخرى.", "error");
    } finally {
      exportButton.disabled = false;
      buttonLabel.textContent = "تحويل إلى PDF";
      if (!urls.length) progressWrap.hidden = true;
    }
  });
})();