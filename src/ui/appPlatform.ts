import { useEffect, type PointerEvent as ReactPointerEvent } from "react";
import type { UiPreferences } from "./uiPreferences";

export function useResponsiveShellLayout(
  petWindowRef: { current: HTMLDivElement | null },
  titlebarRef: { current: HTMLElement | null },
  quickStatsRef: { current: HTMLDivElement | null },
  dockRef: { current: HTMLElement | null },
  uiPreferencesRef: { current: UiPreferences },
  controlScaleDependency: number,
  interfaceFontScaleDependency: number,
): void {
  useEffect(() => {
    const shell = petWindowRef.current;
    const titlebar = titlebarRef.current;
    const quickStats = quickStatsRef.current;
    const dock = dockRef.current;
    if (!shell || !titlebar || !quickStats || !dock || !titlebar.closest(".desktop-shell")) return;

    let frame = 0;
    const numericStyle = (style: CSSStyleDeclaration, property: string) => Number.parseFloat(style.getPropertyValue(property)) || 0;
    const naturalWidth = (element: HTMLElement) => {
      const style = window.getComputedStyle(element);
      const children = [...element.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
      const childWidth = children.reduce((sum, child) => sum + Math.max(child.scrollWidth, child.getBoundingClientRect().width), 0);
      const gap = numericStyle(style, "column-gap") * Math.max(0, children.length - 1);
      const chrome = numericStyle(style, "padding-left") + numericStyle(style, "padding-right")
        + numericStyle(style, "border-left-width") + numericStyle(style, "border-right-width");
      return Math.max(element.scrollWidth, childWidth + gap + chrome);
    };
    const updateLayout = () => {
      frame = 0;
      const drag = titlebar.querySelector<HTMLElement>(".pet-drag-region");
      const headline = titlebar.querySelector<HTMLElement>(".pet-headline-stats");
      const controls = titlebar.querySelector<HTMLElement>(".pet-window-controls");
      if (!drag || !headline || !controls) return;

      const titleStyle = window.getComputedStyle(titlebar);
      const requiredWidth = naturalWidth(drag) + naturalWidth(headline) + naturalWidth(controls)
        + numericStyle(titleStyle, "column-gap") * 2;
      titlebar.classList.toggle("stacked", requiredWidth > titlebar.clientWidth + 0.5);

      const stage = shell.querySelector<HTMLElement>(".pet-stage");
      if (!stage) return;
      const stageTop = stage.getBoundingClientRect().top;
      const titleBottom = Math.max(
        drag.getBoundingClientRect().bottom,
        headline.getBoundingClientRect().bottom,
        controls.getBoundingClientRect().bottom,
      );
      const controlScale = uiPreferencesRef.current.controlScale;
      shell.style.setProperty("--pet-title-safe-bottom", `${Math.ceil(titleBottom - stageTop + 8 * controlScale)}px`);
      const quickRect = quickStats.getBoundingClientRect();
      const quickBottom = quickRect.bottom;
      shell.style.setProperty("--pet-quick-safe-bottom", `${Math.ceil(quickBottom - stageTop + 8 * controlScale)}px`);
      const drawer = shell.querySelector<HTMLElement>(".pet-drawer");
      const drawerRect = drawer?.getBoundingClientRect();
      const drawerCrossesQuickStats = drawerRect
        ? quickRect.left < drawerRect.right && quickRect.right > drawerRect.left
        : false;
      shell.style.setProperty(
        "--pet-drawer-safe-top",
        `${Math.ceil((drawerCrossesQuickStats ? quickBottom : titleBottom) - stageTop + 8 * controlScale)}px`,
      );
      const stageBottom = stage.getBoundingClientRect().bottom;
      const dockTop = dock.getBoundingClientRect().top;
      shell.style.setProperty("--pet-dock-safe-bottom", `${Math.ceil(stageBottom - dockTop + 8 * controlScale)}px`);
    };
    const scheduleLayout = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateLayout);
    };

    const resizeObserver = new ResizeObserver(scheduleLayout);
    resizeObserver.observe(shell);
    resizeObserver.observe(titlebar);
    resizeObserver.observe(quickStats);
    resizeObserver.observe(dock);
    for (const child of titlebar.children) resizeObserver.observe(child);
    const mutationObserver = new MutationObserver(scheduleLayout);
    mutationObserver.observe(titlebar, { childList: true, subtree: true, characterData: true });
    const shellMutationObserver = new MutationObserver(scheduleLayout);
    shellMutationObserver.observe(shell, { childList: true, subtree: true });
    scheduleLayout();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      shellMutationObserver.disconnect();
    };
  }, [controlScaleDependency, interfaceFontScaleDependency]);
}

export function useDesktopShellInteractions(
  expansionModeRef: { current: boolean },
  windowDragActive: { current: boolean },
): void {
  useEffect(() => {
    const onDesktopWheel = (event: WheelEvent) => {
      if (!window.catWorkshopDesktop) return;
      if ((event.target as HTMLElement | null)?.closest(".pet-drawer-content")) return;
      if (expansionModeRef.current) return;
      void window.catWorkshopDesktop.scaleWindow(event.deltaY, event.screenX, event.screenY);
    };
    window.addEventListener("wheel", onDesktopWheel, { capture: true, passive: false });
    return () => window.removeEventListener("wheel", onDesktopWheel, true);
  }, []);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      if (!windowDragActive.current) return;
      window.catWorkshopDesktop?.moveWindowDrag(event.screenX, event.screenY);
    };
    const endWindowDrag = () => {
      if (!windowDragActive.current) return;
      windowDragActive.current = false;
      window.catWorkshopDesktop?.endWindowDrag();
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endWindowDrag);
    window.addEventListener("pointercancel", endWindowDrag);
    window.addEventListener("blur", endWindowDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endWindowDrag);
      window.removeEventListener("pointercancel", endWindowDrag);
      window.removeEventListener("blur", endWindowDrag);
    };
  }, []);
}

export function openRecipeInterface(): void {
  if (window.catWorkshopDesktop) {
    void window.catWorkshopDesktop.openRecipesInBrowser();
    return;
  }
  const recipeWindow = window.open("/recipes.html", "cat-workshop-recipes", "popup,width=1280,height=820");
  recipeWindow?.focus();
}

export function beginDesktopWindowDrag(
  event: ReactPointerEvent<HTMLDivElement>,
  windowDragActive: { current: boolean },
): void {
  if (event.button !== 0 || !window.catWorkshopDesktop) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  windowDragActive.current = true;
  window.catWorkshopDesktop.beginWindowDrag(event.screenX, event.screenY);
}
