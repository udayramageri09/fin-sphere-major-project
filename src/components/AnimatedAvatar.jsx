import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useFBX, useAnimations } from '@react-three/drei';

export function AnimatedAvatar({ isOpen, isSnipping, isMoving }) {
  const group = useRef();
  const fbx = useFBX('/models/Walking.fbx');
  const { actions, names } = useAnimations(fbx.animations, group);

  useEffect(() => {
    if (names.length > 0) {
      const action = actions[names[0]];
      action.reset().fadeIn(0.5).play();
      return () => action.fadeOut(0.5);
    }
  }, [actions, names]);

  useFrame((state) => {
    if (!group.current) return;
    // Subtle breathing/moving animation
    group.current.rotation.y = Math.sin(state.clock.elapsedTime * 0.5) * 0.1;
  });

  return (
    <group ref={group} position={[0, -2.5, 0]} scale={0.012}>
      <primitive object={fbx} />
    </group>
  );
}

// Preload the model
useFBX.preload('/models/Walking.fbx');
