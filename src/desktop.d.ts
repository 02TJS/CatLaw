export {};

declare global {
  interface Window {
    catWorkshopDesktop?: {
      minimize(): void;
      close(): void;
      toggleAlwaysOnTop(): Promise<boolean>;
      scaleWindow(deltaY: number, screenX: number, screenY: number): Promise<{ scale: number; width: number; height: number }>;
      openRecipesInBrowser(): Promise<void>;
      beginWindowDrag(screenX: number, screenY: number): void;
      moveWindowDrag(screenX: number, screenY: number): void;
      endWindowDrag(): void;
    };
  }
}
