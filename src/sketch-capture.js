/* global document, scrollX, scrollY, innerWidth, window, IntersectionObserver, getComputedStyle */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isUuidV7 } from "./plan-state.js";

export class SketchError extends Error {
  /** @param {string} message @param {number} [status] @param {unknown} [response] */
  constructor(message, status, response) {
    super(message);
    this.status = status;
    this.response = response;
  }
}
/** @param {string|Buffer} bytes */
export function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const stableKey = /^[a-zA-Z0-9][-a-zA-Z0-9_]{0,79}$/;
const media = new Map(
  Object.entries({
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  }),
);
/** @param {string} cwd */
export function loadSources(cwd) {
  const root = realpathSync(path.join(cwd, "sketches"));
  if (root !== path.join(realpathSync(cwd), "sketches"))
    throw new SketchError("Use a local sketches directory.");
  /** @param {string} name */
  function load(name) {
    if (
      typeof name !== "string" ||
      !name
        .split("/")
        .every((part) => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part))
    )
      throw new SketchError("Sketch paths must be relative to sketches/.");
    const file = path.join(root, name);
    if (realpathSync(file) !== file || !lstatSync(file).isFile())
      throw new SketchError(
        "Sketch sources must be regular files inside sketches/.",
      );
    return readFileSync(file);
  }
  const boardBytes = load("board.json");
  /** @type {{screens:{id:string,name:string,source:string,sample_keys:string[],plan_subjects:string[]}[],assets:string[]}} */
  const board = JSON.parse(boardBytes.toString());
  if (
    !board ||
    !Array.isArray(board.screens) ||
    board.screens.length < 1 ||
    board.screens.length > 32 ||
    !Array.isArray(board.assets) ||
    !board.assets.every((asset) => typeof asset === "string")
  )
    throw new SketchError(
      "board.json requires 1–32 screens and an assets array.",
    );
  const ids = new Set();
  for (const screen of board.screens) {
    if (
      !screen ||
      typeof screen.id !== "string" ||
      !stableKey.test(screen.id) ||
      typeof screen.name !== "string" ||
      !screen.name.trim() ||
      Buffer.byteLength(screen.name) > 256 ||
      screen.name.includes("\0") ||
      typeof screen.source !== "string" ||
      !screen.source.endsWith(".html") ||
      ids.has(screen.id)
    )
      throw new SketchError(
        "Each screen needs a unique id, a name and an HTML source.",
      );
    for (const field of /** @type {const} */ ([
      "sample_keys",
      "plan_subjects",
    ])) {
      if (screen[field] === undefined) screen[field] = [];
      const references = screen[field];
      if (
        !Array.isArray(references) ||
        references.length > 256 ||
        !references.every(isUuidV7)
      )
        throw new SketchError(
          "sample_keys and plan_subjects must be arrays of Plan subject UUIDs.",
        );
    }
    ids.add(screen.id);
  }
  const files = new Map([["board.json", boardBytes]]);
  for (const name of [
    ...board.assets,
    ...board.screens.map((screen) => screen.source),
  ]) {
    if (!media.has(path.extname(name)))
      throw new SketchError(
        "Use HTML, CSS, images or WOFF2 fonts for sketch sources.",
      );
    files.set(name, load(name));
  }
  return { board, files };
}

// Playwright runs this function inside the screen's document.
/** @param {string} source */
export function bindPlanValues(source) {
  const plan = JSON.parse(source);
  for (const element of document.querySelectorAll("[data-plan-pointer]")) {
    const pointer = element.getAttribute("data-plan-pointer") ?? "";
    if (
      (pointer !== "" && !pointer.startsWith("/")) ||
      /~(?:[^01]|$)/.test(pointer)
    )
      return "Invalid data-plan-pointer.";
    let value = plan;
    for (const token of pointer.split("/").slice(1)) {
      const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
      if (
        value === null ||
        typeof value !== "object" ||
        (Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/.test(key)) ||
        !Object.hasOwn(value, key)
      )
        return "A data-plan-pointer must identify a value in the Plan.";
      value = value[key];
    }
    if (!["string", "number", "boolean"].includes(typeof value))
      return "A data-plan-pointer must identify a scalar example value.";
    element.textContent = String(value);
  }
  return null;
}

/** @param {ReturnType<typeof loadSources>} sources @param {string} planSource */
export async function captureBoard({ board, files }, planSource) {
  try {
    JSON.parse(planSource);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new SketchError(
      "The working Foundation Plan must contain valid JSON.",
    );
  }
  const { chromium, errors } = await import("playwright-core");
  let browser;
  let screenViewport = "";
  let operation = "opening the screen";
  try {
    browser = await chromium
      .launch({
        channel: "chrome",
        ...(process.env.FIRSTDRAFT_CHROME_PATH
          ? { executablePath: process.env.FIRSTDRAFT_CHROME_PATH }
          : {}),
      })
      .catch(() => {
        throw new SketchError(
          "Chrome could not launch. Install Chrome or set FIRSTDRAFT_CHROME_PATH to its executable.",
        );
      });
    const context = await browser.newContext({
      deviceScaleFactor: 1,
      colorScheme: "light",
      locale: "en-US",
      timezoneId: "UTC",
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    const blocked = new Set();
    let malformedPath = false;
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      let name;
      try {
        name = decodeURIComponent(url.pathname.slice(1));
      } catch (error) {
        if (!(error instanceof URIError)) throw error;
        malformedPath = true;
        await route.abort();
        return;
      }
      const body =
        url.origin === "https://sketch.invalid" && name !== "board.json"
          ? files.get(name)
          : undefined;
      if (!body) {
        blocked.add(url.origin);
        await route.abort();
        return;
      }
      await route.fulfill({
        body,
        contentType: media.get(path.extname(name)),
        headers: {
          "Content-Security-Policy":
            "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-src 'none'",
        },
      });
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", () => {
        /** @type {Window & {sketchAssetBlocked?: boolean}} */ (
          window
        ).sketchAssetBlocked = true;
      });
    });
    async function checkAssets() {
      if (malformedPath)
        throw new SketchError(
          "An asset URL has invalid percent encoding. Correct the path in the screen or its stylesheet.",
        );
      if (
        blocked.size ||
        (await page.evaluate(
          () =>
            /** @type {Window & {sketchAssetBlocked?: boolean}} */ (window)
              .sketchAssetBlocked,
        ))
      )
        throw new SketchError(
          "A screen requested an undeclared or external asset. List eligible local assets in board.json.",
        );
    }
    const thumbnail = await context.newPage();
    const screens = [];
    for (const screen of board.screens) {
      /** @param {number} width @param {number} height */
      async function capture(width, height) {
        screenViewport = `${screen.id} (${width} × ${height})`;
        operation = "opening the screen";
        await page.setViewportSize({ width, height });
        await page.goto("https://sketch.invalid/" + screen.source, {
          waitUntil: "load",
        });
        const bindingError = await page.evaluate(bindPlanValues, planSource);
        if (bindingError) throw new SketchError(bindingError);
        await checkAssets();
        operation = "loading the screen’s images and fonts";
        const readiness = await page.waitForFunction(
          async () => {
            for (const image of document.images) image.loading = "eager";
            await document.fonts.ready;
            try {
              await Promise.all(
                Array.from(document.images)
                  .filter(
                    (image) =>
                      image.checkVisibility() &&
                      (image.currentSrc ||
                        image.getAttribute("src") ||
                        image.getAttribute("srcset")),
                  )
                  .map((image) => image.decode()),
              );
            } catch (error) {
              if (
                error instanceof DOMException &&
                error.name === "EncodingError"
              )
                return "invalid-image";
              throw error;
            }
            return "ready";
          },
          undefined,
          { timeout: 15000 },
        );
        await checkAssets();
        if ((await readiness.jsonValue()) === "invalid-image")
          throw new SketchError(
            "Chrome could not decode a visible image. Check that its declared source is a valid image file.",
          );
        await page.evaluate(() => {
          for (const animation of document.getAnimations()) {
            if (animation.effect?.getComputedTiming().endTime === Infinity)
              animation.cancel();
            else animation.finish();
          }
        });
        const fullPage = await page.evaluate(() => {
          const { body, documentElement: root } = document;
          // Chrome captures blank pixels below a viewport-height scrolling body.
          // Let the document scroll for capture while leaving inner panels clipped.
          if (
            body.scrollHeight > root.scrollHeight &&
            ["auto", "scroll"].includes(getComputedStyle(body).overflowY)
          ) {
            body.style.setProperty("overflow-y", "visible", "important");
            body.style.setProperty("overflow-x", "clip", "important");
          }
          return {
            width: Math.max(
              body.scrollWidth,
              root.scrollWidth,
              body.offsetWidth,
              root.offsetWidth,
              body.clientWidth,
              root.clientWidth,
            ),
            height: Math.max(
              body.scrollHeight,
              root.scrollHeight,
              body.offsetHeight,
              root.offsetHeight,
              body.clientHeight,
              root.clientHeight,
            ),
          };
        });
        const content_height = fullPage.height;
        if (content_height > 8192 || fullPage.width > width)
          throw new SketchError(
            "Sketch exceeds its viewport width or 8192px maximum height.",
          );
        const elements = await page.evaluate(async (captureHeight) => {
          const keyed = Array.from(
            document.querySelectorAll("[data-sketch-key]"),
          ).filter((element) =>
            element.checkVisibility({
              visibilityProperty: true,
              opacityProperty: true,
            }),
          );
          if (!keyed.length) return [];

          // Expand only the root viewport to the full-page capture. Chromium still
          // clips each element to its scroll containers and transformed ancestors.
          const intersections =
            await /** @type {Promise<IntersectionObserverEntry[]>} */ (
              new Promise((resolve) => {
                const observer = new IntersectionObserver(
                  (entries) => {
                    observer.disconnect();
                    resolve(entries);
                  },
                  {
                    rootMargin: `0px 0px ${captureHeight}px 0px`,
                  },
                );
                for (const element of keyed) observer.observe(element);
              })
            );
          return intersections
            .filter(
              ({ intersectionRect }) =>
                intersectionRect.width > 0 && intersectionRect.height > 0,
            )
            .map(({ target: element, intersectionRect: bounds }) => {
              const x = Math.max(0, Math.floor(bounds.x + scrollX));
              const y = Math.max(0, Math.floor(bounds.y + scrollY));
              return {
                id: element.getAttribute("data-sketch-key"),
                label: (
                  element.getAttribute("data-sketch-label") ||
                  element.getAttribute("aria-label") ||
                  element.textContent ||
                  ""
                ).trim(),
                x,
                y,
                width:
                  Math.min(innerWidth, Math.ceil(bounds.right + scrollX)) - x,
                height:
                  Math.min(captureHeight, Math.ceil(bounds.bottom + scrollY)) -
                  y,
              };
            })
            .filter((element) => element.width > 0 && element.height > 0);
        }, content_height);
        if (
          elements.length > 512 ||
          new Set(elements.map((element) => element.id)).size !==
            elements.length ||
          elements.some(
            (element) =>
              !element.id ||
              !stableKey.test(element.id) ||
              !element.label ||
              element.label.includes("\0") ||
              Buffer.byteLength(element.label) > 256,
          )
        )
          throw new SketchError(
            "Visible sketch elements need unique keys and labels of at most 256 bytes.",
          );
        operation = "rasterizing the screen";
        const png = await page.screenshot({ fullPage: true, timeout: 15000 });
        if (
          png.readUInt32BE(16) !== width ||
          png.readUInt32BE(20) !== content_height
        )
          throw new SketchError(
            "The page dimensions changed during capture. Keep the root layout stable while its images load.",
          );
        await checkAssets();
        const thumbWidth = Math.min(width, 480);
        await thumbnail.setViewportSize({
          width: thumbWidth,
          height: Math.ceil((content_height * thumbWidth) / width),
        });
        await thumbnail.setContent(
          `<style>*{margin:0}img{display:block;width:100%}</style><img src="data:image/png;base64,${png.toString("base64")}">`,
        );
        const thumb = await thumbnail.screenshot({ timeout: 15000 });
        return {
          width,
          height,
          content_height,
          elements,
          png_base64: png.toString("base64"),
          thumbnail_base64: thumb.toString("base64"),
        };
      }
      const { source, id, name, sample_keys, plan_subjects } = screen;
      const metadata = { id, name, sample_keys, plan_subjects };
      screens.push({
        ...metadata,
        source_sha256: digest(/** @type {Buffer} */ (files.get(source))),
        desktop: await capture(1280, 800),
        mobile: await capture(390, 844),
      });
    }
    return { version: 1, plan_sha256: digest(planSource), screens };
  } catch (error) {
    if (error instanceof SketchError && screenViewport)
      throw new SketchError(`${screenViewport}: ${error.message}`);
    if (error instanceof errors.TimeoutError && screenViewport)
      throw new SketchError(
        `${screenViewport}: Chrome timed out while ${operation}.`,
      );
    throw error;
  } finally {
    await browser?.close();
  }
}
