const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  });
  const page = await ctx.newPage();

  try {
    // Test SBP URL (USDT TRC20)
    console.log("1. Loading SBP exchange page...");
    await page.goto("https://altinbit.com/exchange-usdttrc20-to-sbprub/", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log("   URL: " + page.url());

    // Find ALL select elements
    console.log("\n2. SELECT elements:");
    const selects = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("select")).map(sel => {
        const rect = sel.getBoundingClientRect();
        const options = Array.from(sel.options).map(o => ({ value: o.value, text: o.text.trim().substring(0, 50), selected: o.selected }));
        return {
          name: sel.getAttribute("name"),
          id: sel.id,
          visible: rect.height > 0 && rect.width > 0,
          cls: sel.className.substring(0, 50),
          required: sel.required,
          selectedValue: sel.value,
          label: (() => {
            const lbl = document.querySelector("label[for='" + sel.id + "']");
            return lbl ? lbl.textContent.trim().substring(0, 60) : "";
          })(),
          parentText: (() => {
            const p = sel.closest("div, tr, td, .xchange_field");
            return p ? p.textContent.replace(/\s+/g, " ").trim().substring(0, 100) : "";
          })(),
          options: options.slice(0, 10)
        };
      });
    });
    selects.forEach(s => console.log("   " + JSON.stringify(s)));

    // Find ALL form fields (inputs + selects + textareas)
    console.log("\n3. ALL visible form fields:");
    const fields = await page.evaluate(() => {
      const form = document.querySelector("#ajax_post_bids") || document.querySelector("form");
      if (!form) return "NO FORM FOUND";
      return Array.from(form.querySelectorAll("input, select, textarea")).map(el => {
        const rect = el.getBoundingClientRect();
        const label = document.querySelector("label[for='" + el.id + "']");
        return {
          tag: el.tagName,
          type: el.getAttribute("type"),
          name: el.getAttribute("name"),
          id: el.id,
          value: (el.value || "").substring(0, 30),
          placeholder: (el.getAttribute("placeholder") || "").substring(0, 40),
          visible: rect.height > 0 && rect.width > 0,
          required: el.required,
          cls: el.className.substring(0, 40),
          label: label ? label.textContent.trim().substring(0, 50) : ""
        };
      });
    });
    if (typeof fields === "string") {
      console.log("   " + fields);
    } else {
      fields.forEach(f => console.log("   " + JSON.stringify(f)));
    }

    // Compare with Sberbank form
    console.log("\n4. Loading Sberbank form for comparison...");
    await page.goto("https://altinbit.com/exchange-btc-to-sberrub/", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2000);

    const sberSelects = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("select")).map(sel => {
        const options = Array.from(sel.options).map(o => ({ value: o.value, text: o.text.trim().substring(0, 50) }));
        return { name: sel.getAttribute("name"), id: sel.id, options: options.slice(0, 10) };
      });
    });
    console.log("   Sberbank selects: " + JSON.stringify(sberSelects));

  } catch (err) {
    console.error("ERROR: " + err.message);
  }

  await browser.close();
})();
