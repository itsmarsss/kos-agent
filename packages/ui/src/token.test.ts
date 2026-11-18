// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { changeHeaders, dashboardToken, setDashboardToken, tokenHeaders } from "./api.js";

afterEach(() => sessionStorage.clear());

describe("the dashboard token this tab holds", () => {
  it("is sent with every request once entered, and forgotten with an empty one", () => {
    expect(tokenHeaders()).toEqual({});
    setDashboardToken(" s3cret ");
    expect(dashboardToken()).toBe("s3cret");
    expect(tokenHeaders()).toEqual({ "x-kos-token": "s3cret" });
    expect(changeHeaders()).toMatchObject({ "x-kos-token": "s3cret" });
    setDashboardToken("");
    expect(dashboardToken()).toBeUndefined();
  });
});
