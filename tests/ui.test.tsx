import { afterEach, expect, test, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../src/ui/App";

afterEach(() => vi.unstubAllGlobals());

test("the HeroUI workspace renders all three pages with accessible controls", () => {
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  const html = renderToStaticMarkup(<App />);
  expect(html).toContain('aria-label="主要功能"');
  expect(html).toContain('aria-label="連接埠轉發"');
  expect(html).toContain('aria-label="SSH Config"');
  expect(html).toContain('aria-label="Known Hosts"');
  expect(html).toContain("建立連線");
  expect(html).toContain("尚未儲存主機金鑰");
  expect(html).toContain("button--primary");
  expect(html).toContain("跳到主要內容");
});
