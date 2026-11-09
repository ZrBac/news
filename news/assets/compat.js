/* Safari before 15.4 has no native dialog methods. Keep the same local UI API. */
(() => {
  "use strict";
  const dialogs = [...document.querySelectorAll("dialog")].filter(
    (dialog) =>
      typeof dialog.showModal !== "function" ||
      typeof dialog.close !== "function",
  );
  if (!dialogs.length) return;
  let active = null,
    previousFocus = null;
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  backdrop.hidden = true;
  backdrop.setAttribute("aria-hidden", "true");
  document.body.append(backdrop);
  const resize = () =>
    document.documentElement.style.setProperty(
      "--dialog-height",
      (window.visualViewport?.height || innerHeight) + "px",
    );
  const focusable = () =>
    [
      ...active.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => el.getClientRects().length && !el.hidden);
  const focusFirst = () =>
    (focusable()[0] || active).focus({ preventScroll: true });
  for (const dialog of dialogs) {
    dialog.classList.add("legacy-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("tabindex", "-1");
    Object.defineProperty(dialog, "open", {
      configurable: true,
      get() {
        return this.hasAttribute("open");
      },
      set(value) {
        this.toggleAttribute("open", !!value);
      },
    });
    dialog.showModal = function () {
      if (this.open) return;
      if (active) active.close();
      previousFocus = document.activeElement;
      active = this;
      resize();
      this.open = true;
      this.setAttribute("aria-modal", "true");
      backdrop.hidden = false;
      document.body.classList.add("legacy-dialog-open");
      focusFirst();
    };
    dialog.close = function (value = "") {
      if (!this.open) return;
      this.open = false;
      this.returnValue = String(value);
      this.removeAttribute("aria-modal");
      if (active === this) {
        active = null;
        backdrop.hidden = true;
        document.body.classList.remove("legacy-dialog-open");
        const target = previousFocus;
        previousFocus = null;
        if (target?.isConnected && target.getClientRects().length)
          target.focus({ preventScroll: true });
      }
      this.dispatchEvent(new Event("close"));
    };
  }
  const cancel = () => {
    if (
      active &&
      active.dispatchEvent(new Event("cancel", { cancelable: true }))
    )
      active.close();
  };
  backdrop.addEventListener("click", cancel);
  document.addEventListener(
    "keydown",
    (event) => {
      if (!active) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
      } else if (event.key === "Tab") {
        const controls = focusable(),
          first = controls[0] || active,
          last = controls[controls.length - 1] || active;
        if (
          !active.contains(document.activeElement) ||
          (event.shiftKey &&
            [first, active].includes(document.activeElement)) ||
          (!event.shiftKey && document.activeElement === last)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus({ preventScroll: true });
        }
      }
    },
    true,
  );
  document.addEventListener("focusin", (event) => {
    if (active && !active.contains(event.target)) focusFirst();
  });
  window.addEventListener("resize", resize);
  window.visualViewport?.addEventListener("resize", resize);
})();
