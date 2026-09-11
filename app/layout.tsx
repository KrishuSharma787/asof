import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import { Disclaimer } from "@/components/Disclaimer";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "asof — Indian Act Status Checker",
  description:
    "Checks how Indian courts have interpreted an Act or section, grounded in retrieved judgments.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        {children}
        <Disclaimer />
      </body>
    </html>
  );
}
