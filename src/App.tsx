import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { LandingPage } from "./pages/LandingPage";
import { ResultsPage } from "./pages/ResultsPage";

function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<LandingPage />} />
        <Route path="results" element={<ResultsPage />} />
        {/* unknown routes fall back to the landing page */}
        <Route path="*" element={<LandingPage />} />
      </Route>
    </Routes>
  );
}

export default App;
