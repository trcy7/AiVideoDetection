import { SectionDivider } from "../components/SectionDivider";
import { UploadSection } from "../components/tool/UploadSection";
import { HowItWorks } from "../components/sections/HowItWorks";
import { Features } from "../components/sections/Features";
import { FAQ } from "../components/sections/FAQ";

export function LandingPage() {
  return (
    <>
      {/* UploadSection is the hero: pitch, stats and the tool in one screen */}
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
