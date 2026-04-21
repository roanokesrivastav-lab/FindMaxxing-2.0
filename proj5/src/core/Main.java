package core;

import edu.princeton.cs.algs4.StdDraw;
import edu.princeton.cs.algs4.WeightedQuickUnionUF;
import tileengine.TERenderer;
import tileengine.TETile;
import tileengine.Tileset;

import java.awt.*;
import java.util.HashMap;
import java.util.Random;

public class Main {
    private static final int WIDTH = 100;
    private static final int HEIGHT = 50;

    private static final long SEED = 0;
    private static final Random RANDOM = new Random(SEED);
    private static int spaceThreshold;
    private HashMap<Integer, int[]> rooms;
    private WeightedQuickUnionUF roomConnections;

    /**
     * ronak fill these comments in
     * @param tiles
     */
    public static void generateRooms(TETile[][] tiles) {
        int spaceOccupied = 0;
        while (spaceOccupied < spaceThreshold){
            int leftcornerX = RANDOM.nextInt(WIDTH);
            int leftcornerY = RANDOM.nextInt(HEIGHT);

        }
    }

    /**
     * ronak fill in the room w the tiles
     * @param tiles
     */
    public static void fillRoom(TETile[][] tiles, int leftcornerX, int leftcornerY, int width, int height) {

    }
    public static void connectRooms(TETile[][] tiles){
        return;
    }
    /** Picks a RANDOM tile with a 33% change of being
     *  a wall, 33% chance of being a flower, and 33%
     *  chance of being empty space.
     */
    private static TETile randomTile() {
        // The following call to nextInt() uses a bound of 3 (this is not a seed!) so
        // the result is bounded between 0, inclusive, and 3, exclusive. (0, 1, or 2)
        int tileNum = RANDOM.nextInt(3);
        return switch (tileNum) {
            case 0 -> Tileset.WALL;
            case 1 -> Tileset.FLOWER;
            default -> Tileset.NOTHING;
        };
    }

    public static void main(String[] args) {
        TERenderer ter = new TERenderer();
        ter.initialize(WIDTH, HEIGHT);
        spaceThreshold = (int)(((double)(RANDOM.nextInt(30) + 50)/100) * (WIDTH * HEIGHT));
        TETile[][] randomTiles = new TETile[WIDTH][HEIGHT];
        fillWithRandomTiles(randomTiles);

        StdDraw.clear(new Color(0, 0, 0));
        ter.drawTiles(randomTiles);
        StdDraw.show();
    }

}
