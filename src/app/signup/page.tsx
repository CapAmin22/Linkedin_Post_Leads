import AuthForm from "@/components/AuthForm";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign Up — LeadHarvest",
  description: "Create a LeadHarvest account to start extracting leads",
};

export default function SignupPage() {
  return <AuthForm mode="signup" />;
}
