import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { PaletteProvider } from "@/components/palette-provider";
import { SiteHeader } from "@/components/site-header";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEFAULT_PALETTE, PALETTE_INIT_SCRIPT } from "@/lib/palettes";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    template: "%s · Research Log",
    default: "Research Log",
  },
  description:
    "Log what you read, and map ML research fields into clusters, tensions, and a reading path.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-palette={DEFAULT_PALETTE}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: PALETTE_INIT_SCRIPT }} />
      </head>
      <body className="bg-background text-foreground flex min-h-full flex-col">
        <ThemeProvider>
          <PaletteProvider>
            <TooltipProvider delayDuration={300}>
              <SiteHeader />
              <main className="flex flex-1 flex-col">{children}</main>
              <Toaster position="bottom-right" />
            </TooltipProvider>
          </PaletteProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
