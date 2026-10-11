import "@testing-library/react";
// jsdom has no ResizeObserver (cmdk measures its list) nor scrollIntoView
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= function () {};
