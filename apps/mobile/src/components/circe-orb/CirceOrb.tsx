import { useEffect, useMemo } from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { Canvas, Group, Path, Skia, useClock } from "@shopify/react-native-skia";

import { OrbGlow } from "./OrbGlow";
import { OrbParticles } from "./OrbParticles";
import { OrbSurface } from "./OrbSurface";
import { OrbStrandPlane } from "./WaveField";
import {
  ORB_APPEARANCE,
  ORB_MOTION,
  ORB_PALETTE,
  alphaColor,
  type OrbAppearance,
} from "./orbTokens";
import { resolveOrbParams } from "./orbState";
import type { CirceOrbProps } from "./types";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const MORPH_STEPS = 3;

/**
 * The Circe orb.
 *
 * One bounded Skia canvas owns the whole scene. Layer order is the most
 * important decision here and is not arbitrary:
 *
 *   1. warm atmospheric glow
 *   2. rear fiber strands
 *   3. the dark spherical body, lit by its surface shader
 *   4. the hot rim ring at the hull
 *   5. fibers refracted inside the sphere, clipped to it
 *   6. a few fibers crossing in front
 *   7. microscopic grain
 *
 * Rendering the same fiber field three times is what produces depth. None of
 * this is a real 3D render; three planes are enough for the eye to infer it.
 *
 * Motion is deliberately split: the sphere is nearly stationary and the field
 * around it carries the animation, so the object feels heavy. React never
 * re-renders per frame. Audio level arrives as a shared value and is consumed
 * entirely on the UI thread.
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
  const tuning = ORB_APPEARANCE[appearance];
  const clock = useClock();
  const window = useWindowDimensions();

  const radius = size / 2;
  const fieldWidth = width ?? window.width;
  const fieldHeight = showField ? size * 0.95 : 0;
  const canvasWidth = showField ? fieldWidth : size * 2;
  const canvasHeight = size + fieldHeight * 2;
  const centerX = canvasWidth / 2;
  const centerY = canvasHeight / 2;

  const levelMirror = useSharedValue(typeof level === "number" ? level : 0);
  useEffect(() => {
    if (typeof level === "number") levelMirror.value = level;
  }, [level, levelMirror]);
  const levelSV: SharedValue<number> = typeof level === "object" ? level : levelMirror;

  const breathSV = useSharedValue(1);
  const pulseSV = useSharedValue(0);
  const pressedScale = useSharedValue(1);
  const fieldPhase = useSharedValue(0);

  useEffect(() => {
    if (state !== "success") return;
    pulseSV.value = withTiming(1, { duration: 320 }, () => {
      pulseSV.value = withTiming(0, { duration: 700 });
    });
  }, [pulseSV, state]);

  // One frame callback drives the whole scene: the sphere's breathing and the
  // fiber field phase. Individual strands derive their own phase from this,
  // so there is no per-strand frame work.
  useFrameCallback(() => {
    const t = clock.value / 1000;
    const speed = reducedMotion ? 0 : params.motionSpeed;

    const breath =
      Math.sin((2 * Math.PI * t) / (ORB_MOTION.breathPeriodMs / 1000)) * 0.6 +
      Math.sin((2 * Math.PI * t) / (ORB_MOTION.breathSecondaryMs / 1000) + 1.7) * 0.4;
    breathSV.value = 1 + breath * ORB_MOTION.breathAmplitude * params.breatheScale;

    fieldPhase.value = (fieldPhase.value + 0.09 * params.strandSpeedScale * speed) % MORPH_STEPS;
  });

  const sphereClip = useMemo(
    () => Skia.Path.Circle(centerX, centerY, radius),
    [centerX, centerY, radius],
  );
  const rimRingPath = useMemo(
    () => Skia.Path.Circle(centerX, centerY, radius * 0.994),
    [centerX, centerY, radius],
  );

  // Success adds one restrained outward pulse. No checkmark, no burst.
  const sphereTransform = useDerivedValue(
    () => [{ scale: breathSV.value + pulseSV.value * 0.02 + levelSV.value * 0.004 }],
    [breathSV, levelSV, pulseSV],
  );

  const pressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pressedScale.value }],
  }));

  const rimBoost = params.rimBoost * tuning.rimScale;

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
        <OrbGlow
          centerX={centerX}
          centerY={centerY}
          radius={radius}
          bloomOpacity={params.bloomOpacity}
          bloomRadiusScale={params.bloomRadiusScale}
          appearance={appearance}
          reducedMotion={reducedMotion}
        />

        {showField ? (
          <OrbStrandPlane
            plane="rear"
            width={fieldWidth}
            centerX={centerX}
            centerY={centerY}
            radius={radius}
            fieldPhase={fieldPhase}
            levelSV={levelSV}
            params={params}
            appearance={appearance}
          />
        ) : null}

        <Group origin={{ x: centerX, y: centerY }} transform={sphereTransform}>
          <OrbSurface
            centerX={centerX}
            centerY={centerY}
            radius={radius}
            levelSV={levelSV}
            rimBoost={rimBoost}
            warmth={params.warmth * tuning.warmthScale}
            edgeDepth={params.edgeDepth * tuning.edgeDepthScale}
            rimPhaseSpeed={params.rimPhaseSpeed}
            reducedMotion={reducedMotion}
          />

          {/* The one crisp edge that survives at every size. The shader's
              fresnel ring is soft; this is the hard line on top of it. */}
          <Path
            path={rimRingPath}
            style="stroke"
            strokeWidth={4.5}
            color={alphaColor(ORB_PALETTE.rim, 0.22 * rimBoost)}
          />
          <Path
            path={rimRingPath}
            style="stroke"
            strokeWidth={1.6}
            color={alphaColor(ORB_PALETTE.rim, 0.72)}
          />

          {showField ? (
            <OrbStrandPlane
              plane="interior"
              width={fieldWidth}
              centerX={centerX}
              centerY={centerY}
              radius={radius}
              clip={sphereClip}
              fieldPhase={fieldPhase}
              levelSV={levelSV}
              params={params}
              appearance={appearance}
            />
          ) : null}
        </Group>

        {showField ? (
          <OrbStrandPlane
            plane="front"
            width={fieldWidth}
            centerX={centerX}
            centerY={centerY}
            radius={radius}
            fieldPhase={fieldPhase}
            levelSV={levelSV}
            params={params}
            appearance={appearance}
          />
        ) : null}

        <OrbParticles
          centerX={centerX}
          centerY={centerY}
          radius={radius}
          amount={params.particleAmount}
          reducedMotion={reducedMotion}
        />
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
