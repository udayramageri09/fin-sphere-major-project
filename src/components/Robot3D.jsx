import { useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { Float } from '@react-three/drei';

export function Robot3D({ isOpen, isSnipping }) {
  const group = useRef();
  const globalMouse = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const handleMouseMove = (e) => {
      globalMouse.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      globalMouse.current.y = -(e.clientY / window.innerHeight) * 2 + 1;
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  useFrame(() => {
    if (!group.current || isOpen || isSnipping) {
      if (group.current && isOpen) {
        group.current.rotation.x += (0 - group.current.rotation.x) * 0.1;
        group.current.rotation.y += (0 - group.current.rotation.y) * 0.1;
      }
      return;
    }
    const targetRotationX = -globalMouse.current.y * 0.8;
    const targetRotationY = globalMouse.current.x * 1.5;
    group.current.rotation.x += (targetRotationX - group.current.rotation.x) * 0.1;
    group.current.rotation.y += (targetRotationY - group.current.rotation.y) * 0.1;
  });

  return (
    <Float
      speed={isOpen || isSnipping ? 0 : 3}
      rotationIntensity={isOpen || isSnipping ? 0 : 0.8}
      floatIntensity={isOpen || isSnipping ? 0 : 1.2}
    >
      <group ref={group} rotation={[0, -0.2, 0]} scale={isOpen ? 0.6 : 0.9}>
        {/* Main Head — Matte White / Brushed Chrome */}
        <mesh position={[0, 0, 0]} castShadow receiveShadow>
          <boxGeometry args={[1.6, 1.3, 1.3]} />
          <meshStandardMaterial color="#f4f4f5" roughness={0.25} metalness={0.85} />
        </mesh>

        {/* Screen/Faceplate — Pure Black */}
        <mesh position={[0, 0, 0.66]}>
          <planeGeometry args={[1.4, 1.0]} />
          <meshBasicMaterial color="#09090b" />
        </mesh>

        {/* Left Eye — White glow */}
        <mesh position={[-0.35, 0.1, 0.67]}>
          <capsuleGeometry args={[0.1, 0.25, 4, 8]} />
          <meshBasicMaterial color="#fafafa" />
        </mesh>

        {/* Right Eye — White glow */}
        <mesh position={[0.35, 0.1, 0.67]}>
          <capsuleGeometry args={[0.1, 0.25, 4, 8]} />
          <meshBasicMaterial color="#fafafa" />
        </mesh>

        {/* Cheek marks — subtle warm gray */}
        <mesh position={[-0.45, -0.2, 0.67]}>
          <circleGeometry args={[0.05, 16]} />
          <meshBasicMaterial color="#d4d4d8" transparent opacity={0.6} />
        </mesh>
        <mesh position={[0.45, -0.2, 0.67]}>
          <circleGeometry args={[0.05, 16]} />
          <meshBasicMaterial color="#d4d4d8" transparent opacity={0.6} />
        </mesh>

        {/* Antenna Stem — Brushed Chrome */}
        <mesh position={[0, 0.85, 0]}>
          <cylinderGeometry args={[0.05, 0.05, 0.5]} />
          <meshStandardMaterial color="#a1a1aa" metalness={0.9} roughness={0.2} />
        </mesh>

        {/* Antenna Bulb — White glow */}
        <mesh position={[0, 1.15, 0]}>
          <sphereGeometry args={[0.15, 16, 16]} />
          <meshStandardMaterial color="#fafafa" emissive="#e4e4e7" emissiveIntensity={0.6} />
        </mesh>

        {/* Left Ear piece — Dark chrome */}
        <mesh position={[-0.85, 0, 0]}>
          <cylinderGeometry args={[0.35, 0.35, 0.2]} rotation={[0, 0, Math.PI / 2]} />
          <meshStandardMaterial color="#3f3f46" metalness={0.8} roughness={0.3} />
        </mesh>

        {/* Right Ear piece — Dark chrome */}
        <mesh position={[0.85, 0, 0]}>
          <cylinderGeometry args={[0.35, 0.35, 0.2]} rotation={[0, 0, Math.PI / 2]} />
          <meshStandardMaterial color="#3f3f46" metalness={0.8} roughness={0.3} />
        </mesh>
      </group>
    </Float>
  );
}
