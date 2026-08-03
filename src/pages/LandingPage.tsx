import { Hero } from "../components/Hero";
import { StatsBand } from "../components/StatsBand";
import { SectionDivider } from "../components/SectionDivider";
import { UploadSection } from "../components/tool/UploadSection";
import { HowItWorks } from "../components/sections/HowItWorks";
import { Features } from "../components/sections/Features";
import { FAQ } from "../components/sections/FAQ";

export function LandingPage() {
  return (
    <>
      <Hero />
      <StatsBand />
      <UploadSection />
      <SectionDivider />
      <HowItWorks />
      <SectionDivider />
      <Features />
      <SectionDivider />
      <FAQ />
    </>
  );
}
