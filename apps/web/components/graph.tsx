'use client';

/*
 * The dependency graph, in 3D.
 *
 * The shape carries the meaning rather than decorating it. The failed transaction sits at the
 * centre. Every storage slot it read orbits it on a quiet shell. The slots whose value MOVED are
 * pulled out front on red tethers, and each one is leashed to the transaction that wrote it.
 * A viewer should be able to count the red tethers and know why the send died.
 */

import { Canvas, useFrame } from '@react-three/fiber';
import { Billboard, Line, OrbitControls, Text } from '@react-three/drei';
import { useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

export interface MovedSlot {
  address: string;
  slot: string;
  label?: string;
  from: string;
  to: string;
  writerTx: string;
  writerSender: string;
  writerBlock: string | number;
  sameBlock?: boolean;
}

export interface ExecutedSlot {
  address: string;
  slot: string;
  readOnly?: boolean;
}

/* Tuned for a WHITE stage: saturated enough to sit on paper without glowing. */
const C = {
  moved: '#d8453f',
  dep: '#2f6fdb',
  tx: '#2db742',
  writer: '#d9741f',
} as const;

const short = (s: string, h = 8, t = 6) =>
  s.length <= h + t + 1 ? s : `${s.slice(0, h)}…${s.slice(-t)}`;

/** Fibonacci sphere: even spacing with no clumping at the poles. */
function spherePoint(i: number, total: number, r: number): THREE.Vector3 {
  const k = i + 0.5;
  const phi = Math.acos(1 - (2 * k) / Math.max(total, 1));
  const theta = Math.PI * (1 + Math.sqrt(5)) * k;
  return new THREE.Vector3(
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  );
}

function TxCore() {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((_s, dt) => {
    if (ref.current) ref.current.rotation.y += dt * 0.25;
  });
  return (
    <mesh ref={ref}>
      <icosahedronGeometry args={[1.25, 2]} />
      <meshStandardMaterial
        color={C.tx}
        emissive={C.tx}
        emissiveIntensity={0.25}
        roughness={0.3}
        metalness={0.15}
      />
    </mesh>
  );
}

function Shell({ slots }: { slots: ExecutedSlot[] }) {
  const pts = useMemo(() => slots.map((_, i) => spherePoint(i, slots.length, 6.2)), [slots]);
  return (
    <group>
      {pts.map((p, i) => (
        <group key={i}>
          <mesh position={p}>
            <sphereGeometry args={[0.16, 16, 16]} />
            <meshStandardMaterial color={C.dep} emissive={C.dep} emissiveIntensity={0.12} />
          </mesh>
          <Line points={[[0, 0, 0], p.toArray()]} color={C.dep} transparent opacity={0.22} lineWidth={1} />
        </group>
      ))}
    </group>
  );
}

function MovedNode({
  m,
  index,
  total,
  onPick,
  picked,
}: {
  m: MovedSlot;
  index: number;
  total: number;
  onPick: (i: number) => void;
  picked: boolean;
}) {
  const node = useRef<THREE.Mesh>(null);
  const a = (index / Math.max(total, 1)) * Math.PI * 2;
  const slotPos = useMemo(
    () => new THREE.Vector3(Math.cos(a) * 9.2, Math.sin(a) * 3.1, Math.sin(a) * 9.2),
    [a],
  );
  const writerPos = useMemo(
    () => slotPos.clone().multiplyScalar(1.62).add(new THREE.Vector3(0, 1.5, 0)),
    [slotPos],
  );

  useFrame((s) => {
    if (!node.current) return;
    const t = s.clock.elapsedTime;
    node.current.scale.setScalar((picked ? 1.3 : 1) + Math.sin(t * 2.4 + index * 1.3) * 0.09);
    node.current.rotation.x = t * 0.4;
    node.current.rotation.z = t * 0.3;
  });

  return (
    <group>
      {/* the tether that killed the send */}
      <Line points={[[0, 0, 0], slotPos.toArray()]} color={C.moved} lineWidth={2} transparent opacity={0.9} />

      <mesh
        ref={node}
        position={slotPos}
        onClick={(e) => {
          e.stopPropagation();
          onPick(index);
        }}
        onPointerOver={() => (document.body.style.cursor = 'pointer')}
        onPointerOut={() => (document.body.style.cursor = 'auto')}
      >
        <octahedronGeometry args={[0.72, 0]} />
        <meshStandardMaterial color={C.moved} emissive={C.moved} emissiveIntensity={0.3} roughness={0.25} />
      </mesh>

      <Billboard position={slotPos.clone().add(new THREE.Vector3(0, 1.35, 0))}>
        <Text fontSize={0.4} color={C.moved} anchorX="center">
          {short(m.label ?? m.slot, 12, 6)}
        </Text>
      </Billboard>

      {/* the writer, further out */}
      <Line
        points={[slotPos.toArray(), writerPos.toArray()]}
        color={C.writer}
        lineWidth={1}
        dashed
        dashSize={0.3}
        gapSize={0.2}
        transparent
        opacity={0.65}
      />
      <mesh position={writerPos} onClick={(e) => { e.stopPropagation(); onPick(index); }}>
        <boxGeometry args={[0.78, 0.78, 0.78]} />
        <meshStandardMaterial color={C.writer} emissive={C.writer} emissiveIntensity={0.18} />
      </mesh>
      <Billboard position={writerPos.clone().add(new THREE.Vector3(0, 1.1, 0))}>
        <Text fontSize={0.34} color={C.writer} anchorX="center">
          {`wrote it  ${short(m.writerSender, 6, 4)}`}
        </Text>
      </Billboard>
    </group>
  );
}

function Scene({
  moved,
  executed,
  onPick,
  picked,
}: {
  moved: MovedSlot[];
  executed: ExecutedSlot[];
  onPick: (i: number) => void;
  picked: number | null;
}) {
  // Unchanged dependencies are context. Cap them so the moved ones stay readable.
  const movedKeys = new Set(moved.map((m) => `${m.address}:${m.slot}`.toLowerCase()));
  const shell = executed
    .filter((s) => !movedKeys.has(`${s.address}:${s.slot}`.toLowerCase()))
    .slice(0, 36);

  return (
    <>
      <ambientLight intensity={1.15} />
      <directionalLight position={[8, 14, 10]} intensity={1.6} />
      <pointLight position={[-12, 8, -10]} intensity={60} distance={90} />
      <fogExp2 attach="fog" args={['#ffffff', 0.035]} />
      <TxCore />
      <Billboard position={[0, 2.25, 0]}>
        <Text fontSize={0.42} color={C.tx} anchorX="center">
          your transaction
        </Text>
      </Billboard>
      <Shell slots={shell} />
      {moved.map((m, i) => (
        <MovedNode
          key={`${m.address}:${m.slot}`}
          m={m}
          index={i}
          total={moved.length}
          onPick={onPick}
          picked={picked === i}
        />
      ))}
      <OrbitControls
        enablePan={false}
        autoRotate
        autoRotateSpeed={0.5}
        minDistance={8}
        maxDistance={60}
      />
    </>
  );
}

export function DependencyGraph({
  moved,
  executed,
  onPick,
  picked,
}: {
  moved: MovedSlot[];
  executed: ExecutedSlot[];
  onPick: (i: number) => void;
  picked: number | null;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="flex h-[460px] items-center justify-center p-6 text-center text-[13px] text-dim">
        This browser could not start WebGL, so the 3D graph is unavailable. Every slot is listed
        below in full.
      </div>
    );
  }

  return (
    <div className="relative">
      <Canvas
        camera={{ position: [0, 4.5, 20], fov: 46 }}
        dpr={[1, 2]}
        style={{ height: 520 }}
        onCreated={({ gl }) => gl.setClearColor('#ffffff')}
        fallback={<div className="p-6 text-[13px] text-dim">WebGL unavailable.</div>}
        onError={() => setFailed(true)}
      >
        <Scene moved={moved} executed={executed} onPick={onPick} picked={picked} />
      </Canvas>

      <div className="pointer-events-none absolute bottom-3 left-4 flex flex-wrap gap-4 text-[13px] text-dim">
        {[
          ['moved against you', C.moved],
          ['unchanged dependency', C.dep],
          ['your transaction', C.tx],
          ['the writer', C.writer],
        ].map(([label, colour]) => (
          <span key={label} className="flex items-center gap-1.5">
            <i className="inline-block size-2 rounded-full" style={{ background: colour }} />
            {label}
          </span>
        ))}
      </div>
      <p className="pointer-events-none absolute top-3 right-4 text-[13px] text-faint">
        drag to orbit · scroll to zoom · click a node
      </p>
    </div>
  );
}
