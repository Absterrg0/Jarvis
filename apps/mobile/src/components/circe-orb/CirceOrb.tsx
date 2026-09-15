import { useEffect, useMemo } from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Canvas, Group, Skia, useClock } from "@shopify/react-native-skia";

import { OrbBase } from "./OrbBase";
import { OrbGlow } from "./OrbGlow";
import { OrbParticles } from "./OrbParticles";
import { OrbShell } from "./OrbShell";
import { OrbVolume } from "./OrbVolume";
import { OrbRibbonPlane } from "./RibbonField";
import { ORB_APPEARANCE, ORB_MOTION, type OrbAppearance } from "./orbTokens";

import { resolveOrbParams } from "./orbState";
import type { CirceOrbProps } from "./types";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * The Circe orb.
 *
 * Not a lit solid sphere. It is a dark, semi-volumetric lens: a body that
 * absorbs light, a hot copper shell, a broad atmosphere, and luminous fibers
 * passing through and around it.
 *
 * Layer order carries the whole illusion and is the single most important
 * decision in this file:
 *
 *   1. atmospheric bloom
 *   2. rear ribbon                     (behind the object)
 *   3. sphere group
 *        a. dark absorptive base
 *        b. refracted interior ribbon  (inside the glass)
 *        c. interior volume            (the missing lit volume)
 *        d. transparent shell + lip    (over the glass)
 *   4. front ribbon                    (two filaments, crossing over)
 *   5. grain                           (off in idle)
 *
 * The interior ribbon and the volume pass must both sit between (a) and (d).
 * Painting fibers after an opaque sphere makes them look printed onto its
 * surface, and omitting the volume pass is what leaves a flat black disc
 * between a dark base and a hairline rim.
 *
 * The object barely moves and the field carries the animation. Motion is
 * time-based, never per-frame increments, so a 120 Hz device drifts at the same
 * speed as a 60 Hz one. Audio energy reaches the renderer as a shared value and
 * React never re-renders per frame.
 */
export function CirceOrb({
  state,
  size = 180,
  level = 0,
  interactive = false,
  reducedMotion = false,
  appearance = "light",
  showField = true,
  width,
  onPress,
  accessibilityLabel,
  glyph,
}: CirceOrbProps & {
  readonly glyph?: React.ReactNode;
  readonly appearance?: OrbAppearance;
  readonly showField?: boolean;
  readonly width?: number;
}) {
  const params = resolveOrbParams(state, { reducedMotion });
  const clock = useClock();
  const window = useWindowDimensions();

  const radius = size / 2;
  const fieldWidth = width ?? window.width;

  // Compact scene bounds. The fiber field overscans horizontally through
  // `fieldWidth`; it must not also inflate the canvas vertically, which would
  // push the surrounding layout apart and leave dead space around the orb.
  const verticalPadding = Math.max(34, size * 0.26);
  const canvasWidth = showField ? fieldWidth : size * 2;
  const canvasHeight = size + verticalPadding * 2;
  const centerX = canvasWidth / 2;
  const centerY = canvasHeight / 2;

  const levelMirror = useSharedValue(typeof level === "number" ? level : 0);
  useEffect(() => {
    if (typeof level === "number") levelMirror.value = level;
  }, [level, levelMirror]);
  // `energy` is the single value every responsive part reads from.
  const energySV = typeof level === "object" ? level : levelMirror;

  const breathSV = useSharedValue(1);
  const pulseSV = useSharedValue(0);
  const pressedScale = useSharedValue(1);
  const fieldPhase = useSharedValue(0);

  useEffect(() => {
    if (state !== "success") return;
    pulseSV.value = withTiming(1, { duration: 360 }, () => {
      pulseSV.value = withTiming(0, { duration: 760 });
    });
  }, [pulseSV, state]);

  useFrameCallback((frame) => {
    const t = clock.value / 1000;
    const dt = (frame.timeSincePreviousFrame ?? 16) / 1000;
    const motion = reducedMotion ? 0 : params.motionScale;

    // The sphere is heavy: it only breathes.
    const breath =
      Math.sin((2 * Math.PI * t) / (ORB_MOTION.breathPeriodMs / 1000)) * 0.6 +
      Math.sin((2 * Math.PI * t) / (ORB_MOTION.breathSecondaryMs / 1000) + 1.7) * 0.4;
    breathSV.value = 1 + breath * ORB_MOTION.breathAmplitude;

    // Time-based drift. `fieldCycleSeconds` is the wall-clock duration of one
    // full migration, so the speed is identical on every refresh rate.
    if (Number.isFinite(params.fieldCycleSeconds)) {
      const perSecond = (ORB_MOTION.morphSteps / params.fieldCycleSeconds) * motion;
      fieldPhase.value = (fieldPhase.value + dt * perSecond) % ORB_MOTION.morphSteps;
    }
  });

  const sphereClip = useMemo(
    () => Skia.Path.Circle(centerX, centerY, radius),
    [centerX, centerY, radius],
  );

  const sphereTransform = useDerivedValue(
    () => [
      {
        scale:
          breathSV.value + pulseSV.value * 0.018 + energySV.value * 0.004 * params.energyResponse,
      },
    ],
    [breathSV, energySV, params.energyResponse, pulseSV],
  );

  const pressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pressedScale.value }],
  }));

  const shellIntensity = params.rimIntensity * ORB_APPEARANCE[appearance].shellScale;
  const coreWarmth = params.coreWarmth * ORB_APPEARANCE[appearance].coreWarmthScale;

  const body = (
    <View
      style={{
        width: canvasWidth,
        height: canvasHeight,
        alignItems: "center",
        justifyContent: "center",
      }}
      accessibilityRole={interactive ? "button" : undefined}
    >
      <Canvas style={{ width: canvasWidth, height: canvasHeight }}>
        {/* 1. Atmosphere. */}
        <OrbGlow
          centerX={centerX}
          centerY={centerY}
          radius={radius}
          bloomIntensity={params.bloomIntensity}
          energySV={energySV}
          appearance={appearance}
          reducedMotion={reducedMotion}
        />

        {/* 2. Rear fibers. */}
        {showField ? (
          <OrbRibbonPlane
            plane="rear"
            width={fieldWidth}
            centerX={centerX}
            centerY={centerY}
            radius={radius}
            fieldPhase={fieldPhase}
            energySV={energySV}
            params={params}
            appearance={appearance}
          />
        ) : null}

        {/* 3. The sphere: dark base, refracted fibers, then the shell. */}
        <Group origin={{ x: centerX, y: centerY }} transform={sphereTransform}>
          <OrbBase
            centerX={centerX}
            centerY={centerY}
            radius={radius}
            energySV={energySV}
            coreWarmth={coreWarmth}
          />

          {showField ? (
            <OrbRibbonPlane
              plane="interior"
              width={fieldWidth}
              centerX={centerX}
              centerY={centerY}
              radius={radius}
              clip={sphereClip}
              fieldPhase={fieldPhase}
              energySV={energySV}
              params={params}
              appearance={appearance}
            />
          ) : null}

          <OrbVolume
            centerX={centerX}
            centerY={centerY}
            radius={radius}
            energySV={energySV}
            volumeIntensity={params.volumeIntensity}
          />

          <OrbShell
            centerX={centerX}
            centerY={centerY}
            radius={radius}
            energySV={energySV}
            shellIntensity={shellIntensity}
            reducedMotion={reducedMotion}
          />
        </Group>

        {/* 4. One or two fibers crossing in front. */}
        {showField ? (
          <OrbRibbonPlane
            plane="front"
            width={fieldWidth}
            centerX={centerX}
            centerY={centerY}
            radius={radius}
            fieldPhase={fieldPhase}
            energySV={energySV}
            params={params}
            appearance={appearance}
          />
        ) : null}

        {/* 5. Grain. Zero in idle so the hero frame stays clean. */}
        {params.particleAmount > 0 ? (
          <OrbParticles
            centerX={centerX}
            centerY={centerY}
            radius={radius}
            amount={params.particleAmount}
            reducedMotion={reducedMotion}
          />
        ) : null}
      </Canvas>
      {glyph === undefined ? null : (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {glyph}
        </View>
      )}
    </View>
  );

  if (!interactive) return body;
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? "Circe voice"}
      onPress={onPress}
      onPressIn={() => {
        pressedScale.value = withTiming(0.97, { duration: 120 });
      }}
      onPressOut={() => {
        pressedScale.value = withTiming(1, { duration: 180 });
      }}
      style={[
        { alignItems: "center", justifyContent: "center", minWidth: 44, minHeight: 44 },
        pressStyle,
      ]}
    >
      {body}
    </AnimatedPressable>
  );
}
