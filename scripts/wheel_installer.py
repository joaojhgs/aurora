#!/usr/bin/env python3
"""
Wheel Installation Helper for Aurora
====================================

Handles intelligent installation of llama-cpp-python and other packages
using pre-built wheels with fallback to source compilation.
"""

import subprocess
import sys
import platform
import os
from typing import List, Dict, Optional

class WheelInstaller:
    """Smart wheel installer with fallback to source builds"""
    
    def __init__(self):
        self.system = platform.system().lower()
        self.arch = platform.machine().lower()
        self.python_version = f"{sys.version_info.major}.{sys.version_info.minor}"
        
        # Pre-built wheel configurations
        self.wheel_configs = {
            "pytorch": {
                "cpu": {
                    "primary": [
                        "torch==2.6.0",
                        "torchaudio==2.6.0", 
                        "torchvision==0.21.0"
                    ]
                },
                "cuda": {
                    "primary": [
                        "torch==2.6.0+cu124",
                        "torchaudio==2.6.0+cu124",
                        "torchvision==0.21.0+cu124",
                        "--extra-index-url=https://download.pytorch.org/whl/cu124"
                    ],
                    "legacy": [
                        "torch==2.6.0+cu118",
                        "torchaudio==2.6.0+cu118", 
                        "torchvision==0.21.0+cu118",
                        "--extra-index-url=https://download.pytorch.org/whl/cu118"
                    ]
                },
                "rocm": {
                    "primary": [
                        "torch==2.6.0+rocm6.0",
                        "torchaudio==2.6.0+rocm6.0",
                        "--extra-index-url=https://download.pytorch.org/whl/rocm6.0"
                    ]
                },
                "metal": {
                    # Metal uses CPU torch packages - acceleration happens at framework level
                    "primary": [
                        "torch==2.6.0",
                        "torchaudio==2.6.0", 
                        "torchvision==0.21.0"
                    ]
                },
                "vulkan": {
                    # Vulkan uses CPU torch packages - acceleration happens at framework level
                    "primary": [
                        "torch==2.6.0",
                        "torchaudio==2.6.0", 
                        "torchvision==0.21.0"
                    ]
                },
                "sycl": {
                    # SYCL uses CPU torch packages - acceleration happens at framework level
                    "primary": [
                        "torch==2.6.0",
                        "torchaudio==2.6.0", 
                        "torchvision==0.21.0"
                    ]
                },
                "rpc": {
                    # RPC uses CPU torch packages - acceleration happens at framework level
                    "primary": [
                        "torch==2.6.0",
                        "torchaudio==2.6.0", 
                        "torchvision==0.21.0"
                    ]
                }
            },
            "llama-cpp-python": {
                "cpu": {
                    "primary": [
                        "llama-cpp-python", 
                        "--prefer-binary", 
                        "--extra-index-url=https://abetlen.github.io/llama-cpp-python/whl/cpu/"
                    ],
                    "fallback_env": {
                        "CMAKE_ARGS": "-DGGML_BLAS=ON -DGGML_BLAS_VENDOR=OpenBLAS"
                    },
                    "fallback": ["llama-cpp-python"]
                },
                "cuda": {
                    "primary": [
                        "llama-cpp-python",
                        "--no-cache-dir",
                        "--prefer-binary", 
                        "--extra-index-url=https://abetlen.github.io/llama-cpp-python/whl/cu124/"
                    ],
                    "advanced": [
                        "https://github.com/oobabooga/llama-cpp-python-cuBLAS-wheels/releases/download/textgen-webui/llama_cpp_python_cuda-0.3.8+cu124-cp311-cp311-linux_x86_64.whl"
                    ],
                    "legacy": [
                        "llama-cpp-python",
                        "--prefer-binary",
                        "--extra-index-url=https://jllllll.github.io/llama-cpp-python-cuBLAS-wheels/AVX2/cu118"
                    ],
                    "fallback": ["llama-cpp-python[cuda]"]
                },
                "rocm": {
                    "primary": [
                        "llama-cpp-python",
                        "--prefer-binary",
                        "--extra-index-url=https://abetlen.github.io/llama-cpp-python/whl/rocm/"
                    ],
                    "fallback_env": {
                        "CMAKE_ARGS": "-DGGML_HIPBLAS=ON"
                    },
                    "fallback": ["llama-cpp-python"]
                },
                "metal": {
                    "primary": [
                        "llama-cpp-python",
                        "--prefer-binary",
                        "--extra-index-url=https://abetlen.github.io/llama-cpp-python/whl/metal/"
                    ],
                    "fallback_env": {
                        "CMAKE_ARGS": "-DGGML_METAL=ON"
                    },
                    "fallback": ["llama-cpp-python"]
                },
                "vulkan": {
                    "fallback_env": {
                        "CMAKE_ARGS": "-DGGML_VULKAN=ON"
                    },
                    "fallback": ["llama-cpp-python"]
                },
                "sycl": {
                    "fallback_env": {
                        "CMAKE_ARGS": "-DGGML_SYCL=ON -DCMAKE_C_COMPILER=icx -DCMAKE_CXX_COMPILER=icpx"
                    },
                    "fallback": ["llama-cpp-python"],
                    "pre_install_check": "intel_oneapi"
                },
                "rpc": {
                    "fallback_env": {
                        "CMAKE_ARGS": "-DGGML_RPC=ON"
                    },
                    "fallback": ["llama-cpp-python"]
                }
                        }
        }
    
    def install_package(self, package_name: str, variant: str = "cpu", advanced: bool = False) -> bool:
        """
        Install a package with smart wheel selection
        
        Args:
            package_name: Name of the package (e.g., 'llama-cpp-python')
            variant: Hardware variant ('cpu', 'cuda', 'rocm', 'metal', 'vulkan', 'sycl', 'rpc')
            advanced: Whether to use advanced/experimental wheels
            
        Returns:
            bool: True if installation succeeded, False otherwise
        """
        if package_name not in self.wheel_configs:
            print(f"⚠️  No wheel configuration for {package_name}, using standard pip install")
            return self._pip_install([package_name])

        config = self.wheel_configs[package_name][variant]
        
        # Check pre-installation requirements for certain backends
        if "pre_install_check" in config:
            if not self._check_requirements(config["pre_install_check"]):
                print(f"❌ Pre-installation requirements not met for {variant}")
                return False
        
        # Try advanced wheels first if requested and available
        if advanced and "advanced" in config:
            print(f"🚀 Trying advanced wheels for {package_name} ({variant})...")
            if self._pip_install(config["advanced"]):
                print(f"✅ Successfully installed {package_name} with advanced wheels")
                return True
            print(f"⚠️  Advanced wheels failed, trying primary...")
        
        # Try primary pre-built wheels if available
        if "primary" in config:
            print(f"📦 Trying pre-built wheels for {package_name} ({variant})...")
            if self._pip_install(config["primary"]):
                print(f"✅ Successfully installed {package_name} with pre-built wheels")
                return True
        
        # Try legacy wheels for CUDA
        if variant == "cuda" and "legacy" in config:
            print(f"🔄 Trying legacy CUDA wheels for {package_name}...")
            if self._pip_install(config["legacy"]):
                print(f"✅ Successfully installed {package_name} with legacy wheels")
                return True
        if variant == "cuda" and "legacy" in config:
            print(f"🔄 Trying legacy CUDA wheels for {package_name}...")
            if self._pip_install(config["legacy"]):
                print(f"✅ Successfully installed {package_name} with legacy wheels")
                return True
        
        # Fallback to source compilation
        print(f"🛠️  Pre-built wheels failed, falling back to source compilation...")
        
        # Set environment variables for source build if specified
        env = os.environ.copy()
        if "fallback_env" in config:
            env.update(config["fallback_env"])
            print(f"🔧 Setting build environment: {config['fallback_env']}")
        
        if self._pip_install(config["fallback"], env=env):
            print(f"✅ Successfully compiled {package_name} from source")
            return True
        
        print(f"❌ Failed to install {package_name}")
        return False
    
    def _check_requirements(self, requirement_type: str) -> bool:
        """Check if pre-installation requirements are met"""
        if requirement_type == "intel_oneapi":
            # Check if Intel OneAPI is available
            try:
                oneapi_vars = "/opt/intel/oneapi/setvars.sh"
                if os.path.exists(oneapi_vars):
                    print(f"✅ Intel OneAPI found at {oneapi_vars}")
                    return True
                else:
                    print(f"❌ Intel OneAPI not found. Please install Intel OneAPI toolkit.")
                    print(f"   Required for SYCL backend support.")
                    return False
            except Exception as e:
                print(f"❌ Error checking Intel OneAPI: {e}")
                return False
        return True
    
    def _pip_install(self, args: List[str], env: Optional[Dict[str, str]] = None) -> bool:
        """Execute pip install with given arguments"""
        try:
            cmd = [sys.executable, "-m", "pip", "install"] + args
            result = subprocess.run(
                cmd, 
                check=True, 
                capture_output=True, 
                text=True,
                env=env or os.environ
            )
            return True
        except subprocess.CalledProcessError as e:
            print(f"📋 Installation failed: {e.stderr.strip()}")
            return False
        except Exception as e:
            print(f"📋 Installation error: {str(e)}")
            return False
    
    def install_llama_cpp_python(self, hardware: str = "cpu", advanced: bool = False) -> bool:
        """
        Install llama-cpp-python with optimal wheels for hardware
        
        Args:
            hardware: 'cpu', 'cuda', 'rocm', 'metal', 'vulkan', 'sycl', or 'rpc'
            advanced: Use advanced wheels with latest model support
            
        Returns:
            bool: True if installation succeeded
        """
        print(f"🦙 Installing llama-cpp-python for {hardware.upper()}")
        
        # Validate hardware option
        supported_backends = ["cpu", "cuda", "rocm", "metal", "vulkan", "sycl", "rpc"]
        if hardware not in supported_backends:
            print(f"❌ Unsupported hardware: {hardware}")
            print(f"   Supported backends: {', '.join(supported_backends)}")
            return False
        
        # Platform-specific validations
        if hardware == "metal" and self.system != "darwin":
            print(f"⚠️  Metal backend is only available on macOS")
            print(f"   Current platform: {self.system}")
            return False
            
        return self.install_package("llama-cpp-python", hardware, advanced)

    def install_pytorch(self, hardware: str = "cpu", legacy: bool = False) -> bool:
        """
        Install PyTorch with appropriate backend support
        
        Args:
            hardware: 'cpu', 'cuda', 'rocm', 'metal', 'vulkan', 'sycl', or 'rpc'
            legacy: Use legacy CUDA version (cu118) instead of latest (cu124)
            
        Returns:
            bool: True if installation succeeded
        """
        print(f"🔥 Installing PyTorch for {hardware.upper()}")
        
        # Validate hardware option
        supported_backends = ["cpu", "cuda", "rocm", "metal", "vulkan", "sycl", "rpc"]
        if hardware not in supported_backends:
            print(f"❌ Unsupported hardware: {hardware}")
            print(f"   Supported backends: {', '.join(supported_backends)}")
            return False
        
        # For CUDA, allow legacy version selection
        if hardware == "cuda" and legacy:
            config = self.wheel_configs["pytorch"]["cuda"]["legacy"]
            print(f"🔄 Using legacy CUDA 11.8 packages...")
        else:
            config = self.wheel_configs["pytorch"][hardware]["primary"]
        
        # Install PyTorch packages
        if self._pip_install(config):
            print(f"✅ Successfully installed PyTorch for {hardware.upper()}")
            return True
        else:
            print(f"❌ Failed to install PyTorch for {hardware.upper()}")
            return False

    def install_both(self, hardware: str = "cpu", advanced: bool = False, legacy_torch: bool = False) -> bool:
        """
        Install both PyTorch and llama-cpp-python with matching hardware support
        
        Args:
            hardware: Hardware backend to use
            advanced: Use advanced llama-cpp-python wheels
            legacy_torch: Use legacy PyTorch CUDA version
            
        Returns:
            bool: True if both installations succeeded
        """
        print(f"🚀 Installing PyTorch + llama-cpp-python for {hardware.upper()}")
        print("=" * 50)
        
        # Install PyTorch first
        pytorch_success = self.install_pytorch(hardware, legacy_torch)
        if not pytorch_success:
            print(f"❌ PyTorch installation failed, skipping llama-cpp-python")
            return False
        
        print()  # Add spacing
        
        # Install llama-cpp-python
        llama_success = self.install_llama_cpp_python(hardware, advanced)
        
        if pytorch_success and llama_success:
            print()
            print(f"🎉 Successfully installed both PyTorch and llama-cpp-python for {hardware.upper()}")
            return True
        else:
            print()
            print(f"⚠️  Partial installation - check logs above for details")
            return False

def main():
    """Command-line interface for wheel installer"""
    import argparse
    
    parser = argparse.ArgumentParser(description="Install Aurora packages with pre-built wheels")
    parser.add_argument("--hardware", choices=["cpu", "cuda", "rocm", "metal", "vulkan", "sycl", "rpc"], 
                       default="cpu", help="Hardware acceleration type")
    parser.add_argument("--package", choices=["llama-cpp-python", "pytorch", "both"], 
                       default="llama-cpp-python", help="Package(s) to install")
    parser.add_argument("--advanced", action="store_true", 
                       help="Use advanced llama-cpp-python wheels with latest model support")
    parser.add_argument("--legacy-torch", action="store_true",
                       help="Use legacy PyTorch CUDA version (cu118) instead of cu124")
    
    args = parser.parse_args()
    
    installer = WheelInstaller()
    
    if args.package == "llama-cpp-python":
        success = installer.install_llama_cpp_python(args.hardware, args.advanced)
    elif args.package == "pytorch":
        success = installer.install_pytorch(args.hardware, args.legacy_torch)
    elif args.package == "both":
        success = installer.install_both(args.hardware, args.advanced, args.legacy_torch)
    else:
        success = installer.install_package(args.package, args.hardware, args.advanced)
    
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
