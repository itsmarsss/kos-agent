// @vitest-environment jsdom
import { SearchField } from "@kos/kit";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { railRowKeys, railSearchKeys } from "./railkeys.js";

afterEach(cleanup);

function Rail({ open }: { open: (name: string) => void }): ReactElement {
  const [query, setQuery] = useState("lis");
  return (
    <aside className="chats-list" onKeyDown={railRowKeys}>
      <SearchField className="chats-find" noun="chats" value={query} onChange={setQuery} onKeyDown={railSearchKeys} />
      <a className="chats-root" href="#/kos">KOS</a>
      {["List of books", "Wishlist"].map((name) => (
        <div key={name} className="chats-row">
          <button type="button" className="chats-more">Actions for {name}</button>
          <a className="chats-item" href={`#/${name}`} onClick={(e) => { e.preventDefault(); open(name); }}>
            {name}
          </a>
        </div>
      ))}
    </aside>
  );
}

describe("the chat rail by keys", () => {
  it("opens the first chat found on Enter in the search, not KOS's own row", () => {
    const open = vi.fn();
    render(<Rail open={open} />);
    fireEvent.keyDown(screen.getByPlaceholderText("Search chats"), { key: "Enter" });
    expect(open).toHaveBeenCalledWith("List of books");
  });

  it("steps from the search into the rows and walks them, skipping each row's menu button", () => {
    render(<Rail open={() => undefined} />);
    const search = screen.getByPlaceholderText("Search chats");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("KOS");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("List of books");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Wishlist");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(search);
  });
});
