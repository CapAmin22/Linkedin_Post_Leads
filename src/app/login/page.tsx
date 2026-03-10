import AuthForm from "@/components/AuthForm";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign In — LeadHarvest",
  description: "Sign in to your LeadHarvest account",
};

export default function LoginPage() {
  return <AuthForm mode="login" />;
}
