// Lets the tests import the panel's own .tsx views and the stylesheets they
// pull in. Node strips types from .ts on its own; JSX it does not touch, so
// .tsx goes through Vite's transformer (already a dependency), and a .css
// import becomes an empty module. Wired in through `node --import`.
import { register } from "node:module";

register(new URL("./hooks.mjs", import.meta.url));
