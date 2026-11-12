import { type ReactNode, Suspense } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { loadable } from "./loadable";

function Greeting({ name }: { readonly name: string }) {
  return <p>Hello, {name}</p>;
}

/** What a server draw shows: it cannot wait, so a component that suspends shows the fallback. */
function draw(Shown: (props: { readonly name: string }) => ReactNode): string {
  return renderToStaticMarkup(
    <Suspense fallback={<i>loading</i>}>
      <Shown name="omp" />
    </Suspense>,
  );
}

describe("loadable", () => {
  test("once its code is loaded, the first draw shows it, with no fallback first", async () => {
    const page = loadable(async () => Greeting);
    await page.preload();
    expect(draw(page.Component)).toBe("<p>Hello, omp</p>");
  });

  test("while its code loads it shows the fallback, and its code is loaded once however often it is asked", async () => {
    let loads = 0;
    const page = loadable(async () => {
      loads += 1;
      return Greeting;
    });
    expect(draw(page.Component)).toBe("<i>loading</i>");
    await Promise.all([page.preload(), page.preload()]);
    expect(draw(page.Component)).toBe("<p>Hello, omp</p>");
    expect(loads).toBe(1);
  });
});
