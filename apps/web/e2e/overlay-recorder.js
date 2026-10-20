// In-page recorder for overlay open/close timelines. Installed with addInitScript before the app loads (Chromium) or pasted into a
// Web Inspector console (WebKitGTK). Read-only on the app: it wraps WebSocket.send/message to time `list` calls, samples every frame,
// and (when window.__om.census.on) counts React components that rendered in each commit through the DevTools hook.
(() => {
  if (window.__om) return;
  const now = () => performance.now();
  const om = {
    rec: null,
    calls: new Map(),
    done: [],
    census: { on: false, commits: [] },
    loaf: [],
    ev: [],
    observers: [],
  };
  window.__om = om;

  // ---- WebSocket: time each `list` call from send to its result frame.
  try {
    const NativeWS = window.WebSocket;
    const send = NativeWS.prototype.send;
    NativeWS.prototype.send = function (data) {
      try {
        if (om.rec && typeof data === "string" && data.indexOf('"method":"list"') !== -1) {
          const f = JSON.parse(data);
          if (f.type === "call" && f.method === "list")
            om.calls.set(String(f.id), { sent: now(), port: f.port });
        }
      } catch (_) {}
      return send.call(this, data);
    };
    const onMsg = (ev) => {
      try {
        if (om.calls.size === 0 || typeof ev.data !== "string") return;
        const head = ev.data.slice(0, 160);
        if (head.indexOf('"type":"result"') === -1) return;
        const m = /"id":\s*("[^"]*"|\d+)/.exec(head);
        if (!m) return;
        const id = String(m[1]).replace(/"/g, "");
        const c = om.calls.get(id);
        if (!c) return;
        om.calls.delete(id);
        om.done.push({ sent: c.sent, recv: now(), bytes: ev.data.length });
      } catch (_) {}
    };
    window.WebSocket = new Proxy(NativeWS, {
      construct(target, args) {
        const ws = new target(...args);
        ws.addEventListener("message", onMsg);
        return ws;
      },
    });
  } catch (_) {}

  // ---- Performance observers (Chromium only; absent entries mean the engine does not report them).
  try {
    const o = new PerformanceObserver((l) => om.loaf.push(...l.getEntries()));
    o.observe({ type: "long-animation-frame", buffered: false });
    om.observers.push(o);
  } catch (_) {}
  try {
    const o = new PerformanceObserver((l) => om.ev.push(...l.getEntries()));
    o.observe({ type: "event", durationThreshold: 16, buffered: false });
    om.observers.push(o);
  } catch (_) {}

  // ---- React commit census through the DevTools hook (no-op unless om.census.on).
  // A fiber counts as re-rendered only when the new tree holds a clone of it (alternate !== null) that has the PerformedWork flag, and
  // a subtree is entered only where the new and the previous parent do not share their first child (React skipped the rest).
  try {
    if (window.__omCensus === true && !window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
      const isComponent = (tag) => tag === 0 || tag === 1 || tag === 11 || tag === 14 || tag === 15;
      const census = (root) => {
        const t = now();
        let rendered = 0;
        let mounted = 0;
        const stack = [[root.current, root.current.alternate]];
        while (stack.length) {
          const [f, prev] = stack.pop();
          if (isComponent(f.tag)) {
            if (prev === null) mounted += 1;
            else if ((f.flags & 1) !== 0) {
              rendered += 1;
            }
          }
          if (prev !== null && f.child === prev.child) continue;
          for (let c = f.child; c; c = c.sibling) stack.push([c, c.alternate]);
        }
        om.census.commits.push({ t, n: rendered, m: mounted, ms: now() - t });
      };
      const hook = {
        supportsFiber: true,
        renderers: new Map(),
        inject(r) {
          const id = this.renderers.size + 1;
          this.renderers.set(id, r);
          return id;
        },
        onCommitFiberRoot(_id, root) {
          if (om.census.on) {
            try {
              census(root);
            } catch (_) {}
          }
        },
        onCommitFiberUnmount() {},
        onPostCommitFiberRoot() {},
        checkDCE() {},
        isDisabled: false,
      };
      Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
        value: hook,
        configurable: true,
        writable: true,
      });
    } else if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
      const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      const previous = hook.onCommitFiberRoot;
      const censusExisting = (root) => {
        let rendered = 0;
        let mounted = 0;
        const stack = [[root.current, root.current.alternate]];
        while (stack.length) {
          const [fiber, previousFiber] = stack.pop();
          const component =
            fiber.tag === 0 ||
            fiber.tag === 1 ||
            fiber.tag === 11 ||
            fiber.tag === 14 ||
            fiber.tag === 15;
          if (component) {
            if (previousFiber === null) mounted += 1;
            else if ((fiber.flags & 1) !== 0) {
              rendered += 1;
            }
          }
          if (previousFiber !== null && fiber.child === previousFiber.child) continue;
          for (let child = fiber.child; child; child = child.sibling)
            stack.push([child, child.alternate]);
        }
        om.census.commits.push({
          t: now(),
          n: rendered,
          m: mounted,
          ms: 0,
        });
      };
      hook.onCommitFiberRoot = function (id, root, ...rest) {
        previous?.call(this, id, root, ...rest);
        if (om.census.on) {
          try {
            censusExisting(root);
          } catch (_) {}
        }
      };
    }
  } catch (_) {}

  // ---- Recorder.
  const BACKDROP = '[data-slot="dialog-overlay"]';
  const POPUP = '[role="dialog"][data-overlay-id]';
  const opacityOf = (el) =>
    el ? Math.round(parseFloat(getComputedStyle(el).opacity) * 100) / 100 : -1;
  const watch = (kind, el, rec) => {
    const mark = (name, extra) =>
      rec.marks.push({ n: `${kind}:${name}`, t: now() - rec.t0, x: extra });
    mark("seen");
    const attrs = new MutationObserver(() => {
      const closed = el.hasAttribute("data-closed");
      if (closed && !rec.closedSeen[kind]) {
        rec.closedSeen[kind] = true;
        mark("data-closed");
        try {
          for (const a of el.getAnimations()) {
            const d = a.effect?.getTiming ? a.effect.getTiming().duration : null;
            const name = a.animationName || a.transitionProperty || "anim";
            mark(`anim-start:${name}`, d);
            a.finished.then(
              () => mark(`anim-end:${name}`),
              () => mark(`anim-cancel:${name}`),
            );
          }
        } catch (_) {}
      }
      if (el.getAttribute("aria-hidden") === "true" && !rec.closedSeen[`${kind}-aria`]) {
        rec.closedSeen[`${kind}-aria`] = true;
        mark("aria-hidden");
      }
    });
    attrs.observe(el, {
      attributes: true,
      attributeFilter: ["data-closed", "aria-hidden", "data-ending-style", "inert"],
    });
    const parent = el.parentNode;
    let gone = null;
    if (parent) {
      gone = new MutationObserver(() => {
        if (!el.isConnected) {
          mark("removed");
          gone.disconnect();
          attrs.disconnect();
        }
      });
      gone.observe(parent, { childList: true });
    }
    rec.watchers.push(attrs, gone);
  };

  om.start = (label) => {
    om.calls.clear();
    om.done.length = 0;
    om.loaf.length = 0;
    om.ev.length = 0;
    om.census.commits.length = 0;
    const rec = {
      label,
      t0: now(),
      frames: [],
      marks: [],
      watchers: [],
      seen: {},
      closedSeen: {},
      hits: [],
    };
    om.rec = rec;
    const onEv = (e) => {
      if (!om.rec) return;
      if (
        e.type === "keydown" &&
        !(e.key === "Escape" || (e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey)))
      )
        return;
      rec.marks.push({
        n: `in:${e.type}${e.type === "keydown" ? `:${e.key}` : ""}`,
        t: e.timeStamp - rec.t0,
        ts: e.timeStamp,
      });
    };
    rec.onEv = onEv;
    for (const type of ["pointerdown", "pointerup", "click", "keydown"])
      document.addEventListener(type, onEv, true);
    const loop = (ts) => {
      if (om.rec !== rec) return;
      const bd = document.querySelector(BACKDROP);
      const pop = document.querySelector(POPUP);
      if (bd && !rec.seen.bd) {
        rec.seen.bd = true;
        watch("backdrop", bd, rec);
      }
      if (pop && !rec.seen.pop) {
        rec.seen.pop = true;
        watch("popup", pop, rec);
      }
      const hit = document.elementFromPoint(4, 4);
      rec.frames.push([
        Math.round((ts - rec.t0) * 10) / 10,
        opacityOf(bd),
        opacityOf(pop),
        hit?.closest(BACKDROP) ? 1 : 0,
      ]);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return true;
  };

  om.stop = () => {
    const rec = om.rec;
    om.rec = null;
    if (!rec) return null;
    for (const type of ["pointerdown", "pointerup", "click", "keydown"])
      document.removeEventListener(type, rec.onEv, true);
    for (const w of rec.watchers) if (w) w.disconnect();
    for (const o of om.observers) {
      try {
        for (const e of o.takeRecords()) (e.entryType === "event" ? om.ev : om.loaf).push(e);
      } catch (_) {}
    }
    const t0 = rec.t0;
    const loaf = om.loaf.map((e) => ({
      s: Math.round(e.startTime - t0),
      d: Math.round(e.duration),
      rs: e.renderStart ? Math.round(e.renderStart - e.startTime) : null,
      sl: e.styleAndLayoutStart ? Math.round(e.styleAndLayoutStart - e.startTime) : null,
      b: Math.round(e.blockingDuration || 0),
      sc: (e.scripts || []).slice(0, 4).map((s) => ({
        d: Math.round(s.duration),
        f: Math.round(s.forcedStyleAndLayoutDuration || 0),
        n: s.sourceFunctionName || s.invoker || "",
        u: (s.sourceURL || "").split("/").pop(),
      })),
    }));
    const ev = om.ev.map((e) => ({
      n: e.name,
      s: Math.round(e.startTime - t0),
      d: Math.round(e.duration),
      ip: Math.round(e.processingStart - e.startTime),
      pr: Math.round(e.processingEnd - e.processingStart),
      pd: Math.round(e.startTime + e.duration - e.processingEnd),
    }));
    const lists = om.done.map((c) => ({
      s: Math.round(c.sent - t0),
      ms: Math.round((c.recv - c.sent) * 10) / 10,
      kb: Math.round(c.bytes / 102.4) / 10,
    }));
    const pending = om.calls.size;
    const census = om.census.commits.map((c) => ({
      s: Math.round(c.t - t0),
      n: c.n,
      m: c.m,
      ms: Math.round(c.ms * 10) / 10,
    }));
    return {
      label: rec.label,
      marks: rec.marks,
      frames: rec.frames,
      loaf,
      ev,
      lists,
      pending,
      census,
    };
  };
})();
