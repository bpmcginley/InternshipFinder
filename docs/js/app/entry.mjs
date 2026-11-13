import { createApp } from "./index.mjs";

const { App } = createApp(window);
window.ReactDOM.createRoot(window.document.getElementById("root")).render(window.React.createElement(App));
