"use client";
import React from "react";
import Header from "./Header";
import { usePathname } from "next/navigation";

const MainHeader = () => {
  const pathname = usePathname();

  if (
    pathname === "/admin" ||
    pathname === "/login" ||
    pathname.startsWith("/admin/") ||
    pathname.startsWith("/offer/") ||
    pathname === "/recruiter" ||
    pathname.startsWith("/recruiter/")
  ) {
    return null;
  }

  return <Header />;
};

export default MainHeader;
