import "cesium/Build/Cesium/Widgets/widgets.css";
import "./index.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Residences from "./Residences";

/** Residences is the front page; the analysis tools live at #/twin. */
function Root() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash === "#/twin" ? <App key="twin" /> : <Residences key="home" />;
}

createRoot(document.getElementById("root")!).render(<Root />);
