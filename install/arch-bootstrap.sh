#!/usr/bin/env bash

set -e

echo "🧰 Arch Base Bootstrap Script Starting..."
echo "📦 Installing essential system packages..."

### === [1] Define core package list ===
ESSENTIAL_PACKAGES=(
  # Base system
  base
  base-devel
  linux
  linux-firmware
  linux-headers

  # Shell / CLI tools
  bash
  sudo
  nano
  less
  tar
  gzip
  bzip2
  unzip
  zip
  git
  wget
  curl
  htop

  # Filesystem / mounting / boot
  efibootmgr
  dosfstools
  mtools
  btrfs-progs
  xfsprogs

  # Networking
  networkmanager
  dhclient
  iproute2
  iputils
  net-tools
  openssh
  wget
  curl

  # Locales and time
  glibc
  tzdata
  man-db
  man-pages

  # Bootstrap packages (user request)
  rsync
  reflector
)

### === [2] Install core packages ===
echo "🔍 Checking package installation..."
sudo pacman -Syu --noconfirm
sudo pacman -S --needed --noconfirm "${ESSENTIAL_PACKAGES[@]}"

### === [3] Enable essential services ===
echo "🔧 Enabling essential services..."
sudo systemctl enable NetworkManager

### === [4] Optionally update mirrorlist ===
echo "🌐 Updating mirrorlist with reflector (HTTPS only)..."
sudo reflector --country "Canada" --protocol https --latest 10 --sort rate --save /etc/pacman.d/mirrorlist

echo "✅ Base system and tools installed successfully!"
