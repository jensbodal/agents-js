import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import DocsArchitectureMap from "./components/DocsArchitectureMap.vue";
import DocsCapabilityMap from "./components/DocsCapabilityMap.vue";
import DocsMetaAgent from "./components/DocsMetaAgent.vue";
import "./custom.css";

const theme: Theme = {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("DocsMetaAgent", DocsMetaAgent);
    app.component("DocsArchitectureMap", DocsArchitectureMap);
    app.component("DocsCapabilityMap", DocsCapabilityMap);
  },
};

export default theme;
