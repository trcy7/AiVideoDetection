import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { NavBar } from "./NavBar";
import { Footer } from "./sections/Footer";
import { ThemeToggle } from "../theme/ThemeToggle";

// Restores hash targets after route changes; plain route changes scroll to top.
function ScrollManager() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    if (hash) {
      // wait a frame so the target page has rendered
      requestAnimationFrame(() => {
        document.querySelector(hash)?.scrollIntoView({ behavior: "smooth" });
      });
    } else {
      window.scrollTo(0, 0);
    }
  }, [pathname, hash]);

  return null;
}

export function Layout() {
  return (
    <>
      <ScrollManager />
      <NavBar />
      <main>
        <Outlet />
      </main>
      <Footer />
      <ThemeToggle />
    </>
  );
}
